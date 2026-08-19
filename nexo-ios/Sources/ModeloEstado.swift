import Foundation
import AVFoundation
import Combine
import Network
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
    // Vertical por defecto: Nexo es para contenido de redes, y es lo que
    // promete CamaraEngine al girar la conexion 90 grados. Arrancar en
    // horizontal obligaba a cambiarlo a mano en cada sesion.
    @Published var resolucion = "1080x1920"
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

        // Si el puerto del cable no llega a abrirse, que se vea en pantalla: sin
        // esto la app decia "Listo para transmitir" con la camara funcionando y
        // el PC no podia conectarse, sin ninguna pista de por que.
        servidorCable.alFalloEscucha = { [weak self] motivo in
            Task { @MainActor in self?.mensaje = motivo }
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

        // Parar el anterior ANTES de sustituirlo. Sin esto, cada cambio de lente
        // o de resolucion dejaba viva una VTCompressionSession: son sesiones del
        // codificador por hardware, y al acumularse unas cuantas el video se
        // ahoga hasta casi detenerse.
        codificador?.detener()

        // (Re)crear el codificador. No se le dan medidas: las toma del primer
        // fotograma real de la camara, que es la unica fuente fiable.
        let cod = Codificador()
        cod.alFotograma = { [weak self] datos, micros, clave in
            self?.sesion?.enviarVideo(datos, microsegundos: micros, esClave: clave)
        }
        cod.alCambiarMedidas = { [weak self] in
            Task { @MainActor in self?.publicarEstado() }
        }
        cod.iniciar(fps: Int32(fps), bitrate: bitrate())
        codificador = cod
    }

    private func dimensiones() -> (Int, Int) {
        let partes = resolucion.split(separator: "x").compactMap { Int($0) }
        return partes.count == 2 ? (partes[0], partes[1]) : (1920, 1080)
    }

    private func bitrate() -> Int {
        let (w, h) = dimensiones()
        // El lado mayor, no el ancho. Mirando solo el ancho, 1080x1920 (vertical)
        // caia en el tramo de 6 Mbps pese a tener los mismos pixeles que
        // 1920x1080: la mitad de bitrate del que le toca, y se notaba.
        let lado = max(w, h)
        let base = lado >= 3840 ? 32 : lado >= 2560 ? 20 : lado >= 1920 ? 12 : 6
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
        // Por WiFi el PC exige la clave: escucha en toda la red local y sin ella
        // cualquiera podria ocupar la sesion. La clave se aprende conectando una
        // vez por cable, que es el primer paso de la guia de instalacion.
        guard let clavePC = Emparejamiento.leer() else {
            mensaje = "Conecta una vez por cable para emparejar este PC."
            return
        }
        // Resolver el servicio y conectar. NWConnection acepta el endpoint bonjour
        // directamente, asi que reusamos ClienteWifi con host/puerto resueltos por
        // el propio Network framework a traves del endpoint.
        _ = (name, type, domain)
        let conexion = NWConnection(to: pc.endpoint, using: .tcp)
        let caps: [String: Any] = ["rol": "emisor", "app": "Nexo Cam", "clave": clavePC]
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
            // Lo que esta lente puede dar de verdad. El estudio llena su
            // desplegable con esto: ofrecer una lista fija hacia que se pudieran
            // elegir formatos imposibles, y el movil entregaba otra cosa.
            "formatos": camara.formatosDisponibles().map {
                ["largo": $0.largo, "corto": $0.corto, "fpsMax": $0.fpsMax]
            },
        ]
        // La resolucion de arriba es la PEDIDA. Estas dos son la realidad, y sin
        // ellas un desajuste era invisible desde el PC: el estudio mostraba
        // "1440p horizontal" mientras recibia 1944x2592 vertical.
        var completo = estado
        if let (w, h) = codificador?.medidasActuales {
            completo["resolucionReal"] = "\(w)x\(h)"
        }
        if let (w, h) = camara.medidasFormatoActivo() {
            completo["formatoSensor"] = "\(w)x\(h)"
        }
        sesion?.enviarEstado(completo)
    }

    // --- Cambios desde la propia interfaz del iPhone ------------------------

    func elegirLente(_ id: String) {
        lenteActualID = id
        aplicarCamara()
        publicarEstado()
    }
}
