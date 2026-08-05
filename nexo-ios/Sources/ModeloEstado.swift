import Foundation
import AVFoundation
import Combine
import UIKit

// El cerebro de Nexo Cam: conecta la camara con el codificador y el transporte,
// atiende las ordenes que llegan del PC y publica el estado para la interfaz.
// Es un ObservableObject: SwiftUI se redibuja cuando cambian sus @Published.

@MainActor
final class ModeloEstado: ObservableObject {
    // Estado visible en la interfaz.
    @Published var lentes: [LenteInfo] = []
    @Published var lenteActualID: String?
    @Published var transmitiendo = false
    @Published var conectado = false
    @Published var origenConexion = ""        // "cable" | "wifi"
    @Published var resolucion = "1920x1080"
    @Published var fps = 30
    @Published var pcsWifi: [PCNexo] = []
    @Published var mensaje = "Listo para transmitir"

    // Ajustes de camara actuales (para publicarlos al PC).
    @Published var zoom: CGFloat = 1
    @Published var linterna = false

    private let camara = CamaraEngine()
    private var codificador: Codificador?
    private var sesion: SesionNexo?
    private let servidorCable: ServidorCable
    private let buscador = BuscadorPC()
    private var clienteWifi: ClienteWifi?

    var sesionCamara: AVCaptureSession { camara.sesion }

    init() {
        let caps: [String: Any] = [
            "rol": "emisor",
            "app": "Nexo Cam",
            "modelo": UIDevice.current.model,
        ]
        servidorCable = ServidorCable(capacidades: caps)
        clienteWifi = ClienteWifi(capacidades: caps)

        camara.alFotograma = { [weak self] px, tiempo in
            self?.codificador?.codificar(px, tiempo: tiempo)
        }

        servidorCable.alSesion = { [weak self] ses in
            Task { @MainActor in self?.adoptarSesion(ses, origen: "cable") }
        }

        buscador.alCambio = { [weak self] lista in
            Task { @MainActor in self?.pcsWifi = lista }
        }
    }

    // --- Arranque -----------------------------------------------------------

    func preparar() {
        lentes = CamaraEngine.lentesDisponibles()
        // Arrancar en la principal por defecto.
        lenteActualID = lentes.first(where: { $0.nombre.contains("Principal") })?.id ?? lentes.first?.id
        aplicarCamara()
        servidorCable.iniciar()   // escucha por cable siempre
        buscador.iniciar()        // busca PCs por WiFi
        camara.arrancar()
    }

    private func aplicarCamara() {
        let (ancho, alto) = dimensiones()
        camara.configurar(lenteID: lenteActualID, ancho: ancho, alto: alto, fps: fps)
        // (Re)crear el codificador a la resolucion elegida.
        let cod = Codificador(ancho: Int32(ancho), alto: Int32(alto))
        cod.alFotograma = { [weak self] datos, micros, clave in
            self?.sesion?.enviarVideo(datos, microsegundos: micros, esClave: clave)
        }
        cod.iniciar(fps: Int32(fps), bitrate: bitrate())
        codificador = cod
    }

    private func dimensiones() -> (Int, Int) {
        let partes = resolucion.split(separator: "x").compactMap { Int($0) }
        return partes.count == 2 ? (partes[0], partes[1]) : (1920, 1080)
    }

    private func bitrate() -> Int {
        let (w, _) = dimensiones()
        let base = w >= 3840 ? 32 : w >= 2560 ? 20 : w >= 1920 ? 12 : 6
        return (fps >= 50 ? base * 3 / 2 : base) * 1_000_000
    }

    // --- Conexion -----------------------------------------------------------

    private func adoptarSesion(_ ses: SesionNexo, origen: String) {
        sesion?.cerrar()
        sesion = ses
        origenConexion = origen

        ses.alListo = { [weak self] _ in
            Task { @MainActor in
                self?.conectado = true
                self?.transmitiendo = true
                self?.mensaje = "En directo (\(origen))"
                self?.publicarEstado()
            }
        }
        ses.alControl = { [weak self] orden in
            Task { @MainActor in self?.atenderControl(orden) }
        }
        ses.alFin = { [weak self] in
            Task { @MainActor in
                self?.conectado = false
                self?.transmitiendo = false
                self?.mensaje = "Conexion cerrada"
            }
        }
    }

    func conectarWifi(_ pc: PCNexo) {
        guard case let .service(name, type, domain, _) = pc.endpoint else { return }
        // Resolver el servicio y conectar. NWConnection acepta el endpoint bonjour
        // directamente, asi que reusamos ClienteWifi con host/puerto resueltos por
        // el propio Network framework a traves del endpoint.
        _ = (name, type, domain)
        let conexion = NWConnection(to: pc.endpoint, using: .tcp)
        let caps: [String: Any] = ["rol": "emisor", "app": "Nexo Cam"]
        let ses = SesionNexo(conexion, capacidades: caps)
        adoptarSesion(ses, origen: "wifi")
        ses.iniciar()
    }

    // --- Ordenes del PC -----------------------------------------------------

    private func atenderControl(_ orden: [String: Any]) {
        guard let accion = orden["accion"] as? String else { return }
        switch accion {
        case "cambiar-lente":
            if let id = orden["valor"] as? String { lenteActualID = id; aplicarCamara() }
        case "cambiar-resolucion":
            if let v = orden["valor"] as? String { resolucion = v; aplicarCamara() }
        case "cambiar-fps":
            if let v = orden["valor"] as? Int { fps = v; aplicarCamara() }
            else if let v = orden["valor"] as? String, let n = Int(v) { fps = n; aplicarCamara() }
        case "zoom":
            if let v = numero(orden["valor"]) { zoom = CGFloat(v); camara.aplicarZoom(zoom) }
        case "exposicion":
            if let v = numero(orden["valor"]) { camara.aplicarExposicion(Float(v)) }
        case "iso":
            camara.aplicarISOyObturador(iso: numero(orden["valor"]).map(Float.init), obturadorSeg: nil)
        case "foco":
            camara.aplicarFoco(numero(orden["valor"]).map(Float.init))
        case "linterna":
            linterna.toggle(); camara.aplicarLinterna(linterna)
        default:
            break
        }
        publicarEstado()
    }

    private func numero(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let s = v as? String { return Double(s) }
        return nil
    }

    // --- Estado hacia el PC -------------------------------------------------

    private func publicarEstado() {
        let estado: [String: Any] = [
            "transmitiendo": transmitiendo,
            "lenteActual": lenteActualID ?? "",
            "zoom": Double(zoom),
            "linterna": linterna,
            "resolucion": resolucion,
            "fps": fps,
            "bateria": Int(UIDevice.current.batteryLevel * 100),
            "lentes": lentes.map { ["id": $0.id, "nombre": $0.nombre] },
        ]
        sesion?.enviarEstado(estado)
    }

    // --- Cambios desde la propia interfaz del iPhone ------------------------

    func elegirLente(_ id: String) {
        lenteActualID = id
        aplicarCamara()
        publicarEstado()
    }
}
