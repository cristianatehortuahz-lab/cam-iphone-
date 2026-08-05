import SwiftUI

// Punto de entrada de Nexo Cam.
@main
struct NexoApp: App {
    var body: some Scene {
        WindowGroup {
            VistaPrincipal()
                .preferredColorScheme(.dark)
        }
    }
}
