import Foundation
import Network

// Transporte del lado iPhone. Por CABLE, el telefono escucha en un puerto fijo
// y el PC se conecta a traves del tunel usbmux (verificado en el PC). Por WiFi,
// el telefono se conecta al PC que ha encontrado por Bonjour. En ambos casos,
// una vez hay conexion, se habla el mismo ProtocoloNexo.

// Puerto que el PC busca por usbmux. Debe coincidir con el que use Nexo Desktop.
let PUERTO_CABLE: UInt16 = 7000

final class SesionNexo {
    private let conexion: NWConnection
    private let analizador = AnalizadorNexo()
    private var latido: DispatchSourceTimer?

    var alListo: (([String: Any]) -> Void)?
    var alControl: (([String: Any]) -> Void)?
    var alFin: (() -> Void)?
    private(set) var capacidadesPC: [String: Any] = [:]

    // Capacidades que el iPhone anuncia al presentarse.
    private let capacidades: [String: Any]

    init(_ conexion: NWConnection, capacidades: [String: Any]) {
        self.conexion = conexion
        self.capacidades = capacidades

        analizador.alSaludo = { [weak self] _, caps in
            self?.capacidadesPC = caps
            self?.alListo?(caps)
        }
        analizador.alControl = { [weak self] orden in self?.alControl?(orden) }
    }

    func iniciar() {
        conexion.stateUpdateHandler = { [weak self] estado in
            switch estado {
            case .ready:
                self?.presentarse()
                self?.recibir()
                self?.arrancarLatido()
            case .failed, .cancelled:
                self?.alFin?()
            default:
                break
            }
        }
        conexion.start(queue: .global(qos: .userInitiated))
    }

    private func presentarse() {
        enviar(ProtocoloNexo.codificarSaludo(capacidades))
    }

    private func recibir() {
        conexion.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] datos, _, terminado, error in
            if let d = datos, !d.isEmpty { self?.analizador.alimentar(d) }
            if terminado || error != nil {
                self?.alFin?()
                return
            }
            self?.recibir()
        }
    }

    // --- Envio (llamado desde el pipeline de video) -------------------------

    func enviarVideo(_ datos: Data, microsegundos: UInt64, esClave: Bool) {
        enviar(ProtocoloNexo.codificarMedia(.video, microsegundos: microsegundos,
                                            clave: esClave, datos: datos))
    }

    func enviarAudio(_ datos: Data, microsegundos: UInt64) {
        enviar(ProtocoloNexo.codificarMedia(.audio, microsegundos: microsegundos, datos: datos))
    }

    func enviarEstado(_ estado: [String: Any]) {
        enviar(ProtocoloNexo.codificarJson(.estado, estado))
    }

    private func enviar(_ datos: Data) {
        conexion.send(content: datos, completion: .contentProcessed { _ in })
    }

    private func arrancarLatido() {
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in self?.enviar(ProtocoloNexo.codificarLatido()) }
        t.resume()
        latido = t
    }

    func cerrar() {
        latido?.cancel()
        conexion.cancel()
    }
}

// Escucha por cable: abre un NWListener en PUERTO_CABLE. Cada conexion entrante
// (la trae el PC por usbmux) se convierte en una SesionNexo.
final class ServidorCable {
    private var listener: NWListener?
    private let capacidades: [String: Any]
    var alSesion: ((SesionNexo) -> Void)?

    init(capacidades: [String: Any]) {
        self.capacidades = capacidades
    }

    func iniciar() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            // Escucha SOLO en loopback (127.0.0.1). Por el cable, usbmux entrega
            // las conexiones del PC como locales; por WiFi el iPhone se conecta
            // saliente, asi que este listener no hace falta que sea accesible
            // desde la red. Cerrar la red aqui elimina un agujero de privacidad
            // sin exigir claves ni configuracion al usuario.
            params.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: PUERTO_CABLE)!
            )
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: PUERTO_CABLE)!)
            listener?.newConnectionHandler = { [weak self] conexion in
                guard let self = self else { return }
                // Defensa en profundidad: aunque el bind sea a loopback, se
                // rechaza cualquier conexion cuyo extremo remoto no sea local.
                if !ServidorCable.esLocal(conexion.endpoint) {
                    NSLog("Nexo: conexion rechazada de %@ (no local)", "\(conexion.endpoint)")
                    conexion.cancel()
                    return
                }
                let ses = SesionNexo(conexion, capacidades: self.capacidades)
                self.alSesion?(ses)
                ses.iniciar()
            }
            listener?.start(queue: .global())
            NSLog("Nexo: escuchando por cable (loopback) en el puerto %d", PUERTO_CABLE)
        } catch {
            NSLog("Nexo: no se pudo abrir el puerto de cable: %@", error.localizedDescription)
        }
    }

    private static func esLocal(_ ep: NWEndpoint) -> Bool {
        switch ep {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let a): return a == .loopback || "\(a)" == "127.0.0.1"
            case .ipv6(let a): return a == .loopback || "\(a)".hasPrefix("::1")
            case .name(let n, _): return n == "localhost"
            @unknown default: return false
            }
        default:
            return false
        }
    }

    func detener() {
        listener?.cancel()
        listener = nil
    }
}

// Conexion por WiFi: el iPhone se conecta a un PC encontrado por Bonjour.
final class ClienteWifi {
    private let capacidades: [String: Any]

    init(capacidades: [String: Any]) {
        self.capacidades = capacidades
    }

    func conectar(host: String, puerto: UInt16, alSesion: @escaping (SesionNexo) -> Void) {
        let conexion = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: puerto)!,
            using: .tcp
        )
        let ses = SesionNexo(conexion, capacidades: capacidades)
        alSesion(ses)
        ses.iniciar()
    }
}
