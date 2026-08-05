import SwiftUI
import AVFoundation

// Muestra en pantalla lo que ve la camara. Envuelve AVCaptureVideoPreviewLayer,
// que pinta la sesion de captura directamente, sin pasar por el codificador.
struct VistaPrevia: UIViewRepresentable {
    let sesion: AVCaptureSession

    func makeUIView(context: Context) -> VistaCapa {
        let v = VistaCapa()
        v.capaPrevia.session = sesion
        v.capaPrevia.videoGravity = .resizeAspect
        return v
    }

    func updateUIView(_ uiView: VistaCapa, context: Context) {}

    final class VistaCapa: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var capaPrevia: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
