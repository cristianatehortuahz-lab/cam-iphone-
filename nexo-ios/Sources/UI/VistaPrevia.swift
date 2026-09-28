import SwiftUI
import AVFoundation

// Muestra en pantalla lo que ve la camara. Envuelve AVCaptureVideoPreviewLayer,
// que pinta la sesion de captura directamente, sin pasar por el codificador.
struct VistaPrevia: UIViewRepresentable {
    let sesion: AVCaptureSession
    // Recibe la capa ya creada, para que la camara la gire. Sin esto nadie le
    // fijaba el angulo y, con el movil en horizontal, la previa salia tumbada.
    var alCrearCapa: @MainActor (AVCaptureVideoPreviewLayer) -> Void = { _ in }

    func makeUIView(context: Context) -> VistaCapa {
        let v = VistaCapa()
        v.capaPrevia.session = sesion
        v.capaPrevia.videoGravity = .resizeAspect
        alCrearCapa(v.capaPrevia)
        return v
    }

    func updateUIView(_ uiView: VistaCapa, context: Context) {}

    final class VistaCapa: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var capaPrevia: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
