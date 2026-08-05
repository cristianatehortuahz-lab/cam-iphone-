import Foundation
import AVFoundation
import CoreMedia

// Motor de captura del iPhone. Gestiona la sesion de camara, las lentes
// disponibles (ultra gran angular, principal, frontal), la resolucion/fps y los
// controles manuales (zoom, exposicion, ISO, foco). Entrega cada fotograma como
// CVPixelBuffer al codificador.

struct LenteInfo: Identifiable, Equatable {
    let id: String          // identificador unico del AVCaptureDevice
    let nombre: String      // nombre amable para la interfaz
    let tipoRaw: String
}

final class CamaraEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let sesion = AVCaptureSession()
    private let colaVideo = DispatchQueue(label: "nexo.camara.video")
    private var entrada: AVCaptureDeviceInput?
    private let salida = AVCaptureVideoDataOutput()
    private(set) var dispositivoActual: AVCaptureDevice?

    // Entrega de fotogramas (buffer, marca de tiempo).
    var alFotograma: ((CVPixelBuffer, CMTime) -> Void)?
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

        // Orientacion vertical por defecto (contenido para redes).
        if let con = salida.connection(with: .video) {
            if #available(iOS 17.0, *) {
                con.videoRotationAngle = 90
            }
        }

        sesion.commitConfiguration()
        alEstado?()
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
        var mejor: AVCaptureDevice.Format?
        var mejorPuntuacion = Int.max
        for f in disp.formats {
            let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let soportaFps = f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(fps) }
            guard soportaFps else { continue }
            // Distancia a la resolucion pedida (preferimos igual o mayor).
            let d = abs(Int(dim.width) - ancho) + abs(Int(dim.height) - alto)
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
            d.setFocusModeLockedWithLensPosition(max(0, min(p, 1)), completionHandler: nil)
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
        guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let tiempo = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        alFotograma?(px, tiempo)
    }
}
