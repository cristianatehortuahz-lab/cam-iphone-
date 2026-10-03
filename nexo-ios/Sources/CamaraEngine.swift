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
    // Cola propia para configurar y arrancar/parar la sesion. Antes esto se
    // hacia en el hilo principal (configurar) y en la cola de entrega de
    // fotogramas (arrancar/parar), y ninguno de los dos es su sitio:
    // beginConfiguration/commitConfiguration y startRunning BLOQUEAN hasta que
    // la sesion se rehace. Con la orden llegando desde el PC, el hilo principal
    // se quedaba colgado dentro de configurar y publicarEstado no volvia a
    // ejecutarse nunca: cero fotogramas y cero estados, medido.
    private let colaSesion = DispatchQueue(label: "nexo.camara.sesion")
    // Protege lo que la cola de sesion escribe y el hilo principal lee al
    // publicar el estado. Sin esto, mover la configuracion de hilo cambiaria un
    // cuelgue por una carrera de datos.
    private let candado = NSLock()
    private var entrada: AVCaptureDeviceInput?
    private let salida = AVCaptureVideoDataOutput()
    private var _dispositivoActual: AVCaptureDevice?
    var dispositivoActual: AVCaptureDevice? {
        candado.lock(); defer { candado.unlock() }; return _dispositivoActual
    }
    // Ultimo angulo de giro que la conexion acepto de verdad. Se publica al PC
    // para poder comprobar la orientacion con datos en vez de a ojo.
    private var _giroAplicado: Int = 0
    var giroAplicado: Int {
        candado.lock(); defer { candado.unlock() }; return _giroAplicado
    }
    // El angulo que, segun iOS, deja el horizonte recto con el movil tal como se
    // sostiene ahora. Se publica junto al aplicado: si difieren en 90 grados, el
    // movil esta en vertical con horizontal pedido (o al reves).
    private var _giroHorizonte: Int = 0
    var giroHorizonte: Int {
        candado.lock(); defer { candado.unlock() }; return _giroHorizonte
    }

    // Coordinador de giro de Apple: sabe, para cada lente, que angulo deja la
    // imagen derecha segun como se sostiene el movil, y avisa cuando cambia.
    // Se rehace con cada configuracion. Solo se tocan en colaSesion.
    private var coordinador: AVCaptureDevice.RotationCoordinator?
    private var observaciones: [NSKeyValueObservation] = []
    private var quiereVertical = true
    // La capa de la vista previa del propio iPhone. La crea la interfaz y la
    // registra aqui; debil porque es suya.
    private weak var _capaPrevia: AVCaptureVideoPreviewLayer?
    // iOS interrumpe la captura por su cuenta (llamada entrante, otra app
    // tomando la camara, falta de recursos). Si no se mira, la app parece
    // funcionar mientras no entrega un solo fotograma.
    private var _interrumpida = false
    var interrumpida: Bool {
        candado.lock(); defer { candado.unlock() }; return _interrumpida
    }

    // Audio. Va por su propia cola: mezclarlo con la de video haria que un
    // fotograma pesado retrasara el sonido, que es mucho mas sensible a los
    // saltos.
    private let colaAudio = DispatchQueue(label: "nexo.camara.audio")
    private let salidaAudio = AVCaptureAudioDataOutput()
    private var _entradaAudio: AVCaptureDeviceInput?
    private var entradaAudio: AVCaptureDeviceInput? {
        candado.lock(); defer { candado.unlock() }; return _entradaAudio
    }

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
        colaSesion.async { [weak self] in
            self?.configurarEnCola(lenteID: lenteID, ancho: ancho, alto: alto, fps: fps)
        }
    }

    private func configurarEnCola(lenteID: String?, ancho: Int, alto: Int, fps: Int) {
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
                candado.lock(); _dispositivoActual = disp; candado.unlock()
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

        sesion.commitConfiguration()

        // El microfono se anade APARTE, ya cerrada la configuracion del video.
        // Metido dentro, un fallo suyo se llevaba por delante la sesion entera y
        // la camara dejaba de entregar fotogramas: sin video, sin formato
        // aplicado y sin conexion sobre la que fijar el giro.
        anadirAudioSiSePuede()

        // Orientacion. Va DESPUES del commit: dentro del bloque de
        // configuracion, cambiar activeFormat justo antes puede rehacer la
        // conexion y perder el angulo. Si no se aplica, la camara entrega tal
        // cual sale del sensor.
        quiereVertical = alto > ancho
        prepararGiro(disp)

        DispatchQueue.main.async { [weak self] in self?.alEstado?() }
    }

    // Anade el microfono en su propia transaccion. El video ya esta funcionando
    // cuando se llama, asi que si algo de esto falla se pierde el sonido pero
    // no la imagen.
    private func anadirAudioSiSePuede() {
        guard entradaAudio == nil,
              AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
              let micro = AVCaptureDevice.default(for: .audio),
              let entradaMic = try? AVCaptureDeviceInput(device: micro)
        else { return }

        // Sin poner la categoria en grabacion, anadir el microfono puede
        // interrumpir la sesion de captura entera. Faltaba, y es la causa mas
        // probable de que la camara dejara de entregar buffers.
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .videoRecording,
                                  options: [.mixWithOthers, .defaultToSpeaker])
            try audio.setActive(true)
        } catch {
            NSLog("Nexo: no se pudo preparar el audio (%@); se sigue sin sonido",
                  error.localizedDescription)
            return
        }

        sesion.beginConfiguration()
        if sesion.canAddInput(entradaMic) {
            sesion.addInput(entradaMic)
            candado.lock(); _entradaAudio = entradaMic; candado.unlock()
            salidaAudio.setSampleBufferDelegate(self, queue: colaAudio)
            if sesion.canAddOutput(salidaAudio) { sesion.addOutput(salidaAudio) }
            NSLog("Nexo: microfono anadido")
        }
        sesion.commitConfiguration()
    }

    // --- Giro -----------------------------------------------------------------

    // La interfaz entrega aqui la capa de su vista previa, para girarla con el
    // mismo coordinador que la salida. Sin esto la previa del propio iPhone se
    // quedaba en el angulo por defecto y, con el movil en horizontal, salia
    // tumbada dentro de una franja vertical. Medido el 28/09/2026.
    func registrarCapaPrevia(_ capa: AVCaptureVideoPreviewLayer) {
        candado.lock(); _capaPrevia = capa; candado.unlock()
        colaSesion.async { [weak self] in
            guard let self, let disp = self.dispositivoActual else { return }
            self.prepararGiro(disp)
        }
    }

    // Crea el coordinador para la lente activa, aplica los angulos y los
    // mantiene al dia cuando cambia la forma de sostener el movil. Corre en
    // colaSesion.
    private func prepararGiro(_ disp: AVCaptureDevice) {
        observaciones.removeAll()
        candado.lock(); let capa = _capaPrevia; candado.unlock()
        let coord = AVCaptureDevice.RotationCoordinator(device: disp, previewLayer: capa)
        coordinador = coord
        let esFrontal = disp.position == .front

        aplicarGiroSalida(horizonte: coord.videoRotationAngleForHorizonLevelCapture, esFrontal: esFrontal)
        observaciones.append(coord.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, cambio in
            guard let angulo = cambio.newValue else { return }
            self?.colaSesion.async { self?.aplicarGiroSalida(horizonte: angulo, esFrontal: esFrontal) }
        })

        if let capa {
            aplicarGiroPrevia(capa, coord.videoRotationAngleForHorizonLevelPreview)
            observaciones.append(coord.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self, weak capa] _, cambio in
                guard let angulo = cambio.newValue, let capa else { return }
                self?.aplicarGiroPrevia(capa, angulo)
            })
        }
    }

    // El estudio decide la PROPORCION (vertical u horizontal); el coordinador,
    // HACIA QUE LADO. Antes el angulo era fijo por proporcion y lente, y
    // sostener el movil en horizontal "al reves" daba la imagen boca abajo: la
    // proporcion era buena, el lado no. Medido el 28/09/2026.
    //
    // Que pareja de angulos da cada proporcion SI esta medida, lente por lente
    // (64c7106), y se comprobo otra vez el 28/09/2026 pidiendo cada una por orden
    // explicita desde el estudio:
    //
    //   trasera  0 / 180  -> 3840x2160 (apaisado)
    //   trasera  90 / 270 -> 2160x3840 (vertical)
    //   frontal  0 / 180  -> 2160x3840 (vertical)   <- al reves
    //   frontal  90 / 270 -> 3840x2160 (apaisado)
    //
    // De la pareja se usa el angulo mas cercano al que deja el horizonte recto.
    // Si empatan —el movil se sostiene al contrario de lo pedido, en vertical con
    // horizontal elegido— no hay forma de enderezarlo sin cambiar la proporcion,
    // y se queda el primero, que es el que se usaba siempre.
    private func aplicarGiroSalida(horizonte: CGFloat, esFrontal: Bool) {
        guard let con = salida.connection(with: .video) else { return }
        let pareja: [CGFloat] = esFrontal
            ? (quiereVertical ? [0, 180] : [270, 90])
            : (quiereVertical ? [90, 270] : [0, 180])
        let preferidos = distanciaAngular(pareja[1], horizonte) < distanciaAngular(pareja[0], horizonte)
            ? [pareja[1], pareja[0]]
            : pareja

        guard let angulo = preferidos.first(where: { con.isVideoRotationAngleSupported($0) }) else {
            candado.lock(); _giroAplicado = 0; _giroHorizonte = Int(horizonte); candado.unlock()
            NSLog("Nexo: ningun giro admitido; se emite tal cual sale del sensor")
            return
        }
        if con.videoRotationAngle != angulo { con.videoRotationAngle = angulo }
        // Se publica al PC. Sin esto, saber que angulo acepto cada lente exige
        // leer los logs del movil, que desde el PC no se ven.
        candado.lock(); _giroAplicado = Int(angulo); _giroHorizonte = Int(horizonte); candado.unlock()
        NSLog("Nexo: giro %.0f (horizonte %.0f, %@, %@)", angulo, horizonte,
              esFrontal ? "frontal" : "trasera", quiereVertical ? "vertical" : "horizontal")
    }

    // La previa no tiene proporcion pedida: se endereza sin mas. Toca una capa,
    // asi que va en el hilo principal.
    private func aplicarGiroPrevia(_ capa: AVCaptureVideoPreviewLayer, _ angulo: CGFloat) {
        DispatchQueue.main.async {
            guard let con = capa.connection, con.isVideoRotationAngleSupported(angulo) else { return }
            con.videoRotationAngle = angulo
        }
    }

    // Separacion entre dos angulos en grados, por el camino corto (0...180).
    private func distanciaAngular(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        let d = abs(a - b).truncatingRemainder(dividingBy: 360)
        return min(d, 360 - d)
    }

    // La parte del estado que sale de la camara, leida en colaSesion: va en
    // orden con las configuraciones, asi que refleja la ultima ya aplicada, y
    // nadie mas toca la sesion de captura mientras tanto. `entrega` se llama en
    // esa misma cola.
    func leerParaEstado(_ entrega: @escaping ([String: Any]) -> Void) {
        colaSesion.async { [weak self] in
            guard let self else { return }
            var d: [String: Any] = [
                // Lo que esta lente puede dar de verdad. El estudio llena su
                // desplegable con esto: ofrecer una lista fija hacia que se
                // pudieran elegir formatos imposibles, y el movil entregaba
                // otra cosa.
                "formatos": self.formatosDisponibles().map {
                    ["largo": $0.largo, "corto": $0.corto, "fpsMax": $0.fpsMax]
                },
                // Rangos de zoom, exposicion, enfoque y linterna. El estudio
                // los necesita para mostrar esos controles: sin ellos los
                // escondia.
                "capacidades": self.capacidades(),
                "audio": self.hayAudio,
                "giro": self.giroAplicado,
                // El que deja el horizonte recto segun como se sostiene el
                // movil. Si coincide con el aplicado, la imagen sale derecha;
                // si difiere en 90, el movil se sostiene al contrario de lo
                // pedido (en vertical con horizontal elegido). Una diferencia
                // de 180 era el fallo de antes: imagen boca abajo.
                "giroHorizonte": self.giroHorizonte,
                "captura": self.diagnostico(),
            ]
            if let (w, h) = self.medidasFormatoActivo() {
                d["formatoSensor"] = "\(w)x\(h)"
            }
            entrega(d)
        }
    }

    // Para poder ver desde el PC si la captura esta viva. Sin esto, "no llegan
    // fotogramas" podia ser media docena de cosas distintas.
    func diagnostico() -> [String: Any] {
        [
            "corriendo": sesion.isRunning,
            "conexionVideo": salida.connection(with: .video) != nil,
            "entradas": sesion.inputs.count,
            "salidas": sesion.outputs.count,
            "interrumpida": interrumpida,
            "audio": entradaAudio != nil,
        ]
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

    // Los controles tocan el dispositivo en colaSesion, igual que la
    // configuracion y por lo mismo: lockForConfiguration espera si otro hilo lo
    // tiene, y quien los llama es el hilo principal.
    private func conDispositivo(_ accion: @escaping (AVCaptureDevice) -> Void) {
        colaSesion.async { [weak self] in
            guard let d = self?.dispositivoActual else { return }
            accion(d)
        }
    }

    func aplicarZoom(_ factor: CGFloat) {
        conDispositivo { d in
            try? d.lockForConfiguration()
            d.videoZoomFactor = max(1, min(factor, d.activeFormat.videoMaxZoomFactor))
            d.unlockForConfiguration()
        }
    }

    func aplicarExposicion(_ ev: Float) {
        conDispositivo { d in
            guard d.isExposureModeSupported(.continuousAutoExposure) else { return }
            try? d.lockForConfiguration()
            let objetivo = max(d.minExposureTargetBias, min(ev, d.maxExposureTargetBias))
            d.setExposureTargetBias(objetivo)
            d.unlockForConfiguration()
        }
    }

    func aplicarISOyObturador(iso: Float?, obturadorSeg: Float?) {
        conDispositivo { d in
            guard d.isExposureModeSupported(.custom) else { return }
            try? d.lockForConfiguration()
            let dur = obturadorSeg.map { CMTime(seconds: Double($0), preferredTimescale: 1_000_000) }
                ?? AVCaptureDevice.currentExposureDuration
            let isoObjetivo = iso.map { max(d.activeFormat.minISO, min($0, d.activeFormat.maxISO)) }
                ?? AVCaptureDevice.currentISO
            d.setExposureModeCustom(duration: dur, iso: isoObjetivo)
            d.unlockForConfiguration()
        }
    }

    func aplicarFoco(_ pos: Float?) {
        conDispositivo { d in
            try? d.lockForConfiguration()
            if let p = pos, d.isFocusModeSupported(.locked) {
                d.setFocusModeLocked(lensPosition: max(0, min(p, 1)), completionHandler: nil)
            } else if d.isFocusModeSupported(.continuousAutoFocus) {
                d.focusMode = .continuousAutoFocus
            }
            d.unlockForConfiguration()
        }
    }

    func aplicarLinterna(_ encendida: Bool) {
        conDispositivo { d in
            guard d.hasTorch else { return }
            try? d.lockForConfiguration()
            try? d.setTorchModeOn(level: encendida ? 1.0 : 0.0)
            if !encendida { d.torchMode = .off }
            d.unlockForConfiguration()
        }
    }

    // Modos de enfoque y balance de blancos, que el estudio ofrece como listas.
    // Antes mandaba 'enfoque' y 'balance' y el movil no los entendia: eran dos
    // desplegables que no hacian absolutamente nada.
    func aplicarModoEnfoque(_ modo: String) {
        conDispositivo { d in
            try? d.lockForConfiguration()
            if modo == "bloqueado", d.isFocusModeSupported(.locked) {
                d.focusMode = .locked
            } else if d.isFocusModeSupported(.continuousAutoFocus) {
                d.focusMode = .continuousAutoFocus
            }
            d.unlockForConfiguration()
        }
    }

    func aplicarModoBalance(_ modo: String) {
        conDispositivo { d in
            try? d.lockForConfiguration()
            if modo == "bloqueado", d.isWhiteBalanceModeSupported(.locked) {
                d.whiteBalanceMode = .locked
            } else if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                d.whiteBalanceMode = .continuousAutoWhiteBalance
            }
            d.unlockForConfiguration()
        }
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

    // Avisos de iOS sobre la sesion. Se registran una vez.
    func vigilarInterrupciones() {
        let c = NotificationCenter.default
        c.addObserver(forName: .AVCaptureSessionWasInterrupted, object: sesion, queue: nil) { [weak self] n in
            self?.fijarInterrumpida(true)
            let motivo = (n.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int) ?? -1
            NSLog("Nexo: captura interrumpida (motivo %d)", motivo)
            self?.alEstado?()
        }
        c.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: sesion, queue: nil) { [weak self] _ in
            self?.fijarInterrumpida(false)
            NSLog("Nexo: captura reanudada")
            self?.alEstado?()
        }
        c.addObserver(forName: .AVCaptureSessionRuntimeError, object: sesion, queue: nil) { [weak self] n in
            let e = n.userInfo?[AVCaptureSessionErrorKey]
            NSLog("Nexo: error de captura: %@", "\(e ?? "desconocido")")
            // Reintentar: un error puntual no deberia dejar la camara muerta.
            self?.arrancar()
        }
    }

    private func fijarInterrumpida(_ v: Bool) {
        candado.lock(); _interrumpida = v; candado.unlock()
    }

    func arrancar() {
        colaSesion.async { [weak self] in
            if let s = self?.sesion, !s.isRunning { s.startRunning() }
        }
    }

    func parar() {
        colaSesion.async { [weak self] in
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
