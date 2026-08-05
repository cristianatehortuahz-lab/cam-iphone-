import SwiftUI
import AVFoundation

// Pantalla principal de Nexo Cam. Previa a pantalla completa, con una cabecera
// de estado, el selector de lente abajo y la lista de PCs por WiFi cuando no hay
// cable. Diseño oscuro, en linea con la marca.

struct VistaPrincipal: View {
    @StateObject private var modelo = ModeloEstado()
    @State private var permisoConcedido = false

    var body: some View {
        ZStack {
            Color(red: 0.043, green: 0.051, blue: 0.063).ignoresSafeArea()

            if permisoConcedido {
                VistaPrevia(sesion: modelo.sesionCamara)
                    .ignoresSafeArea()
            }

            VStack {
                cabecera
                Spacer()
                controles
            }
            .padding()
        }
        .task { await pedirPermisos() }
        .statusBarHidden(true)
    }

    // --- Cabecera de estado -------------------------------------------------

    private var cabecera: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(modelo.transmitiendo ? Color.green : (modelo.conectado ? Color.orange : Color.gray))
                .frame(width: 10, height: 10)
                .shadow(color: modelo.transmitiendo ? .green : .clear, radius: 5)
            Text(modelo.mensaje)
                .font(.subheadline).foregroundColor(.white)
            Spacer()
            if !modelo.origenConexion.isEmpty {
                Text(modelo.origenConexion.uppercased())
                    .font(.caption2).bold()
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.white.opacity(0.12))
                    .cornerRadius(6)
                    .foregroundColor(.white)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial)
        .cornerRadius(12)
    }

    // --- Controles inferiores ----------------------------------------------

    private var controles: some View {
        VStack(spacing: 14) {
            // PCs por WiFi (solo si no hay conexion por cable).
            if !modelo.conectado && !modelo.pcsWifi.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Conectar por WiFi").font(.caption).foregroundColor(.gray)
                    ForEach(modelo.pcsWifi) { pc in
                        Button { modelo.conectarWifi(pc) } label: {
                            HStack {
                                Image(systemName: "wifi")
                                Text(pc.nombre)
                                Spacer()
                            }
                            .padding(10)
                            .background(Color.white.opacity(0.08))
                            .cornerRadius(10)
                            .foregroundColor(.white)
                        }
                    }
                }
            }

            // Selector de lente.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(modelo.lentes) { lente in
                        Button { modelo.elegirLente(lente.id) } label: {
                            Text(lente.nombre)
                                .font(.caption).bold()
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(modelo.lenteActualID == lente.id
                                            ? Color(red: 0.24, green: 0.61, blue: 1.0)
                                            : Color.white.opacity(0.10))
                                .foregroundColor(modelo.lenteActualID == lente.id ? .black : .white)
                                .cornerRadius(10)
                        }
                    }
                }
            }

            // Pista de conexion por cable.
            if !modelo.conectado {
                Text("Conecta el cable USB-C al PC y abre Nexo en el ordenador.")
                    .font(.caption).foregroundColor(.gray)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial)
        .cornerRadius(12)
    }

    // --- Permisos -----------------------------------------------------------

    private func pedirPermisos() async {
        let camara = await AVCaptureDevice.requestAccess(for: .video)
        // Sin audio de momento; se anadira cuando se implemente la captura.
        await MainActor.run {
            permisoConcedido = camara
            if camara {
                UIDevice.current.isBatteryMonitoringEnabled = true
                UIApplication.shared.isIdleTimerDisabled = true // no bloquear la pantalla en directo
                modelo.preparar()
            } else {
                modelo.mensaje = "Sin permiso de camara. Actívalo en Ajustes."
            }
        }
    }
}
