import Foundation
import AVFoundation
import CoreMedia

// Motor de captura del iPhone. Gestiona la sesion de camara, las lentes
// disponibles (ultra gran angular, principal, frontal), la resolucion/fps y los
// controles manuales (zoom, exposicion, ISO, foco). Entrega cada fotograma como
// CVPixelBuffer al codificador.

// Una resolucion que la lente puede entregar de verdad, en lados largo/corto
// (los formatos del sensor vienen siempre apaisados). El estudio deriva de aqui
// la pareja vertical/horizontal.
struct FormatoInfo: Equatable {
    let largo: Int
    let corto: Int
    let fpsMax: Int
}

struct LenteInfo: Identifiable, Equatable {
    let id: String          // identificador unico del AVCaptureDevice
    let nombre: String      // nombre amable para la interfaz
    let tipoRaw: String
}

final class CamaraEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let sesion = AVCaptureSession()
    private let colaVideo = DispatchQueue(label: "nexo.camara.video")
    private var entrada: AVCaptureDeviceInput?
    private let salida = AVCaptureVideoDataOutput()
    private(set) var dispositivoActual: AVCaptureDevice?
    // Ultimo angulo de giro que la conexion acepto de verdad. Se publica al PC
    // para poder comprobar la orientacion con datos en vez de a ojo.
    private(set) var giroAplicado: Int = 0

    // Audio. Va por su propia cola: mezclarlo con la de video haria que un
    // fotograma pesado retrasara el sonido, que es mucho mas sensible a los
    // saltos.
    private let colaAudio = DispatchQueue(label: "nexo.camara.audio")
    private let salidaAudio = AVCaptureAudioDataOutput()
    private var entradaAudio: AVCaptureDeviceInput?

    // Entrega de fotogramas (buffer, marca de tiempo).
    var alFotograma: ((CVPixelBuffer, CMTime) -> Void)?
    // Entrega de bloques de sonido en crudo, para codificarlos a AAC.
    var alAudio: ((CMSampleBuffer) -> Void)?
    // Aviso de cambios de estado para la interfaz (lente, ajustes).
    var alEstado: (() -> Void)?

    // --- Lentes disponibles -------------------------------------------------

    static func lentesDisponibles() -> [LenteInfo] {
        var tipos: [AVCaptureDevice.DeviceType] = [
            .builtInUltraWideCamera,
            .builtInWideAngleCamera,
            .builtInTelephotoCamera,
        ]
        // La frontal se descubre aparte por su posicion.
        let traseras = AVCaptureDevice.DiscoverySession(
            deviceTypes: tipos, mediaType: .video, position: .back
        ).devices

        tipos = [.builtInTrueDepthCamera, .builtInWideAngleCamera]
        let frontales = AVCaptureDevice.DiscoverySession(
            deviceTypes: tipos, mediaType: .video, position: .front
        ).devices.prefix(1)

        func nombre(_ d: AVCaptureDevice) -> String {
            switch d.deviceType {
            case .builtInUltraWideCamera: return "Ultra gran angular · 0,5x"
            case .builtInTelephotoCamera: return "Teleobjetivo"
            case .builtInTrueDepthCamera: return "Frontal"
            default: return d.position == .front ? "Frontal" : "Principal · 1x"
            }
        }

        return (traseras + Array(frontales)).map {
            LenteInfo(id: $0.uniqueID, nombre: nombre($0), tipoRaw: $0.deviceType.rawValue)
        }
    }

    // --- Configuracion ------------------------------------------------------

    func configurar(lenteID: String?, ancho: Int, alto: Int, fps: Int) {
        sesion.beginConfiguration()
        sesion.sessionPreset = .inputPriority // el formato lo fija el dispositivo

        // Elegir dispositivo: el pedido, o la principal trasera por defecto.
        let dispositivo = dispositivoPorID(lenteID)
            ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        guard let disp = dispositivo else {
            sesion.commitConfiguration()
            return
        }

        // Quitar la entrada anterior.
        if let e = entrada { sesion.removeInput(e) }

        do {
            let nuevaEntrada = try AVCaptureDeviceInput(device: disp)
            if sesion.canAddInput(nuevaEntrada) {
                sesion.addInput(nuevaEntrada)
                entrada = nuevaEntrada
                dispositivoActual = disp
            }
        } catch {
            NSLog("Nexo: no se pudo abrir la lente: %@", error.localizedDescription)
        }

        // Elegir el formato que mejor case con ancho/alto/fps pedidos.
        if let formato = mejorFormato(disp, ancho: ancho, alto: alto, fps: fps) {
            try? disp.lockForConfiguration()
            disp.activeFormat = formato
            let duracion = CMTime(value: 1, timescale: CMTimeScale(fps))
            disp.activeVideoMinFrameDuration = duracion
            disp.activeVideoMaxFrameDuration = duracion
            disp.unlockForConfiguration()
        }

        // Salida de video en formato compatible con VideoToolbox (NV12).
        salida.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ]
        salida.alwaysDiscardsLateVideoFrames = true
        salida.setSampleBufferDelegate(self, queue: colaVideo)
        if sesion.canAddOutput(salida) { sesion.addOutput(salida) }

        // Microfono. Solo si hay permiso: pedirlo aqui bloquearia la
        // configuracion, y sin el la camara debe seguir funcionando igual.
        if entradaAudio == nil,
           AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
           let micro = AVCaptureDevice.default(for: .audio),
           let entradaMic = try? AVCaptureDeviceInput(device: micro),
           sesion.canAddInput(entradaMic) {
            sesion.addInput(entradaMic)
            entradaAudio = entradaMic
            salidaAudio.setSampleBufferDelegate(self, queue: colaAudio)
            if sesion.canAddOutput(salidaAudio) { sesion.addOutput(salidaAudio) }
        }

        sesion.commitConfiguration()

        // Orientacion vertical (contenido para redes). Va DESPUES del commit y
        // comprobando que el angulo esta soportado: dentro del bloque de
        // configuracion, cambiar activeFormat justo antes puede rehacer la
        // conexion y perder el angulo, y asignar uno no soportado se ignora en
        // silencio. Si esto no se aplica, la camara entrega apaisado.
        if let con = salida.connection(with: .video), #available(iOS 17.0, *) {
            // El giro depende de lo que se PIDE, no es fijo. Antes se aplicaban
            // 90 grados siempre: las traseras salian verticales aunque pidieras
            // horizontal, y la frontal salia horizontal aunque pidieras vertical.
            // La orientacion elegida en el estudio se ignoraba por completo.
            //
            // El sensor entrega apaisado, asi que para horizontal no hay que
            // girar nada. Para vertical hay que girarlo, y la frontal necesita el
            // sentido contrario a las traseras porque su sensor esta al reves.
            // Horizontal no necesita giro (el sensor ya entrega apaisado) y
            // vertical si. La frontal prueba 270 antes que 90 porque su sensor
            // va al reves, con respaldo a lo otro si el angulo no esta admitido.
            let quiereVertical = alto > ancho
            let esFrontal = disp.position == .front
            let preferidos: [CGFloat] = quiereVertical
                ? (esFrontal ? [270, 90] : [90, 270])
                : [0, 180]

            if let angulo = preferidos.first(where: { con.isVideoRotationAngleSupported($0) }) {
                con.videoRotationAngle = angulo
                // Se publica al PC. Sin esto, saber que angulo acepto cada lente
                // exige leer los logs del movil, que desde el PC no se ven: era
                // adivinar en vez de medir.
                giroAplicado = Int(angulo)
                NSLog("Nexo: giro %.0f grados (%@, %@)", angulo,
                      disp.position == .front ? "frontal" : "trasera",
                      quiereVertical ? "vertical" : "horizontal")
            } else {
                giroAplicado = 0
                NSLog("Nexo: ningun giro admitido; se emite tal cual sale del sensor")
            }
        }

        alEstado?()
    }

    // Resoluciones que la lente ACTUAL puede dar, sin repetir y de mayor a
    // menor. El estudio llena su desplegable con esto en vez de con una lista
    // fija: cada lente tiene formatos distintos, y ofrecer imposibles hacia que
    // se eligiera algo que el sensor no podia dar, entregando otra cosa sin
    // avisar.
    func formatosDisponibles() -> [FormatoInfo] {
        guard let disp = dispositivoActual else { return [] }
        var porClave: [String: FormatoInfo] = [:]
        for f in disp.formats {
            let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let largo = max(Int(dim.width), Int(dim.height))
            let corto = min(Int(dim.width), Int(dim.height))
            let fpsMax = Int(f.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0)
            guard fpsMax > 0 else { continue }
            let clave = "\(largo)x\(corto)"
            // Con varios formatos del mismo tamano nos quedamos con el que mas
            // fps admite: es el que menos limita al usuario.
            if let previo = porClave[clave], previo.fpsMax >= fpsMax { continue }
            porClave[clave] = FormatoInfo(largo: largo, corto: corto, fpsMax: fpsMax)
        }
        return porClave.values.sorted { $0.largo > $1.largo }
    }

    // Medidas del formato de sensor activo. Sirven para comprobar que
    // VideoToolbox no escalo: si lo codificado coincide con esto (girado o no),
    // no hubo deformacion posible.
    func medidasFormatoActivo() -> (Int, Int)? {
        guard let disp = dispositivoActual else { return nil }
        let dim = CMVideoFormatDescriptionGetDimensions(disp.activeFormat.formatDescription)
        return (Int(dim.width), Int(dim.height))
    }

    private func dispositivoPorID(_ id: String?) -> AVCaptureDevice? {
        guard let id = id else { return nil }
        let todos = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera, .builtInTrueDepthCamera],
            mediaType: .video, position: .unspecified
        ).devices
        return todos.first { $0.uniqueID == id }
    }

    private func mejorFormato(_ disp: AVCaptureDevice, ancho: Int, alto: Int, fps: Int) -> AVCaptureDevice.Format? {
        // Los formatos del sensor vienen SIEMPRE en horizontal, aunque la
        // captura se gire despues. Asi que se comparan lados largos con lados
        // largos y cortos con cortos.
        //
        // Comparando en crudo, pedir 1080x1920 (vertical) daba distancia 1680
        // contra el formato 1920x1080 y solo 1400 contra 1280x720: elegia 720p
        // para una peticion de 1080p y luego lo escalaba. Vertical salia blando.
        let pedidoLargo = max(ancho, alto)
        let pedidoCorto = min(ancho, alto)

        var mejor: AVCaptureDevice.Format?
        var mejorPuntuacion = Int.max
        for f in disp.formats {
            let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let soportaFps = f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(fps) }
            guard soportaFps else { continue }
            let dimLargo = max(Int(dim.width), Int(dim.height))
            let dimCorto = min(Int(dim.width), Int(dim.height))

            // La PROPORCION manda sobre el tamano. Sin esto, pidiendo 2560x1440
            // (16:9) el formato 4:3 del sensor (2592x1944) puntuaba 536 y el
            // 16:9 de verdad (3840x2160) puntuaba 2000: ganaba el 4:3 y el
            // encuadre no era el pedido, sin ningun aviso.
            let propPedida = Double(pedidoLargo) / Double(pedidoCorto)
            let propFormato = Double(dimLargo) / Double(dimCorto)
            let castigoProp = Int(abs(propPedida - propFormato) * 10_000)

            // Distancia a la resolucion pedida (preferimos igual o mayor).
            let d = castigoProp + abs(dimLargo - pedidoLargo) + abs(dimCorto - pedidoCorto)
            if d < mejorPuntuacion {
                mejorPuntuacion = d
                mejor = f
            }
        }
        return mejor
    }

    // --- Controles manuales -------------------------------------------------

    func aplicarZoom(_ factor: CGFloat) {
        guard let d = dispositivoActual else { return }
        try? d.lockForConfiguration()
        d.videoZoomFactor = max(1, min(factor, d.activeFormat.videoMaxZoomFactor))
        d.unlockForConfiguration()
    }

    func aplicarExposicion(_ ev: Float) {
        guard let d = dispositivoActual, d.isExposureModeSupported(.continuousAutoExposure) else { return }
        try? d.lockForConfiguration()
        let objetivo = max(d.minExposureTargetBias, min(ev, d.maxExposureTargetBias))
        d.setExposureTargetBias(objetivo)
        d.unlockForConfiguration()
    }

    func aplicarISOyObturador(iso: Float?, obturadorSeg: Float?) {
        guard let d = dispositivoActual, d.isExposureModeSupported(.custom) else { return }
        try? d.lockForConfiguration()
        let dur = obturadorSeg.map { CMTime(seconds: Double($0), preferredTimescale: 1_000_000) }
            ?? AVCaptureDevice.currentExposureDuration
        let isoObjetivo = iso.map { max(d.activeFormat.minISO, min($0, d.activeFormat.maxISO)) }
            ?? AVCaptureDevice.currentISO
        d.setExposureModeCustom(duration: dur, iso: isoObjetivo)
        d.unlockForConfiguration()
    }

    func aplicarFoco(_ pos: Float?) {
        guard let d = dispositivoActual else { return }
        try? d.lockForConfiguration()
        if let p = pos, d.isFocusModeSupported(.locked) {
            d.setFocusModeLocked(lensPosition: max(0, min(p, 1)), completionHandler: nil)
        } else if d.isFocusModeSupported(.continuousAutoFocus) {
            d.focusMode = .continuousAutoFocus
        }
        d.unlockForConfiguration()
    }

    func aplicarLinterna(_ encendida: Bool) {
        guard let d = dispositivoActual, d.hasTorch else { return }
        try? d.lockForConfiguration()
        try? d.setTorchModeOn(level: encendida ? 1.0 : 0.0)
        if !encendida { d.torchMode = .off }
        d.unlockForConfiguration()
    }

    // Modos de enfoque y balance de blancos, que el estudio ofrece como listas.
    // Antes mandaba 'enfoque' y 'balance' y el movil no los entendia: eran dos
    // desplegables que no hacian absolutamente nada.
    func aplicarModoEnfoque(_ modo: String) {
        guard let d = dispositivoActual else { return }
        try? d.lockForConfiguration()
        if modo == "bloqueado", d.isFocusModeSupported(.locked) {
            d.focusMode = .locked
        } else if d.isFocusModeSupported(.continuousAutoFocus) {
            d.focusMode = .continuousAutoFocus
        }
        d.unlockForConfiguration()
    }

    func aplicarModoBalance(_ modo: String) {
        guard let d = dispositivoActual else { return }
        try? d.lockForConfiguration()
        if modo == "bloqueado", d.isWhiteBalanceModeSupported(.locked) {
            d.whiteBalanceMode = .locked
        } else if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            d.whiteBalanceMode = .continuousAutoWhiteBalance
        }
        d.unlockForConfiguration()
    }

    // Rangos reales de la lente activa, con la forma que el estudio ya sabe
    // pintar (configurarDeslizador y rellenarLista en viewer.js). Sin esto, esas
    // funciones escondian el zoom, la exposicion y el enfoque por no recibir
    // ningun rango: los controles existian y nunca aparecian.
    func capacidades() -> [String: Any] {
        guard let d = dispositivoActual else { return [:] }
        var c: [String: Any] = [:]

        // Se limita el zoom: activeFormat.videoMaxZoomFactor llega a valores
        // absurdos (>100) que son recorte digital puro y no aportan nada.
        let zoomMax = min(Double(d.activeFormat.videoMaxZoomFactor), 10)
        c["zoom"] = ["min": 1.0, "max": zoomMax, "step": 0.1,
                     "valor": Double(d.videoZoomFactor)]

        if d.isExposureModeSupported(.continuousAutoExposure) {
            c["exposicion"] = ["min": Double(d.minExposureTargetBias),
                               "max": Double(d.maxExposureTargetBias),
                               "step": 0.1,
                               "valor": Double(d.exposureTargetBias)]
        }

        // La lista ya incluye "automatico" por su cuenta (opcion de valor
        // vacio), asi que aqui solo van los modos explicitos.
        c["modosEnfoque"] = d.isFocusModeSupported(.locked) ? ["bloqueado"] : []
        c["modosBalance"] = d.isWhiteBalanceModeSupported(.locked) ? ["bloqueado"] : []
        c["linterna"] = d.hasTorch
        return c
    }

    // --- Ciclo de vida ------------------------------------------------------

    func arrancar() {
        colaVideo.async { [weak self] in
            if let s = self?.sesion, !s.isRunning { s.startRunning() }
        }
    }

    func parar() {
        colaVideo.async { [weak self] in
            if let s = self?.sesion, s.isRunning { s.stopRunning() }
        }
    }

    // --- Recepcion de fotogramas -------------------------------------------

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        // El mismo delegado atiende video y audio: se distinguen por la salida
        // que los entrega, no por el contenido.
        if output === salidaAudio {
            alAudio?(sampleBuffer)
            return
        }
        guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let tiempo = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        alFotograma?(px, tiempo)
    }

    // ¿Hay microfono conectado a la sesion? Lo usa el estado para decir si la
    // grabacion llevara sonido.
    var hayAudio: Bool { entradaAudio != nil }
}
