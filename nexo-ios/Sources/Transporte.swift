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
            // Por cable el PC incluye su clave: aprovechamos para emparejar, y
            // asi este iPhone podra volver a ese PC por WiFi sin teclear nada.
            if let k = caps["clave"] as? String, !k.isEmpty {
                Emparejamiento.guardar(k)
            }
            self?.alListo?(caps)
        }
        analizador.alControl = { [weak self] orden in self?.alControl?(orden) }

        // Se devuelve la marca del PC junto a la nuestra. Con la ida y vuelta,
        // el PC calcula cuanto adelanta o atrasa el reloj de este iPhone
        // respecto al suyo, que es lo que permite alinear varias camaras al
        // montar: cada movil marca sus fotogramas con SU reloj.
        analizador.alLatido = { [weak self] obj in
            guard let self = self else { return }
            var respuesta: [String: Any] = ["movil": Date().timeIntervalSince1970 * 1000]
            if let pc = obj["pc"] { respuesta["pc"] = pc }
            self.enviar(ProtocoloNexo.codificarJson(.latido, respuesta))
        }
        // Un flujo que incumple el protocolo no se recupera: se corta la conexion
        // en vez de seguir acumulando.
        analizador.alError = { [weak self] mensaje in
            NSLog("Nexo: protocolo invalido: %@", mensaje)
            self?.cerrar()
            self?.alFin?()
        }
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
    // Se avisa si el puerto no llega a abrirse. Sin esto el fallo solo iba a un
    // NSLog invisible: la camara se veia bien, la app decia "Listo para
    // transmitir" y desde el PC parecia un problema de cable.
    var alFalloEscucha: ((String) -> Void)?

    init(capacidades: [String: Any]) {
        self.capacidades = capacidades
    }

    func iniciar() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true

            // NO se usa requiredLocalEndpoint para atarlo a 127.0.0.1. Esa
            // propiedad es para fijar el extremo local de una CONEXION saliente;
            // en un listener, combinada con el puerto de NWListener(using:on:),
            // deja al listener en estado .failed y el puerto nunca se abre. Se
            // veia como que el cable no funcionaba: la camara arrancaba, la app
            // decia "Listo para transmitir" y el PC no podia conectarse.
            //
            // La privacidad se mantiene igual: el newConnectionHandler de abajo
            // ya rechaza toda conexion cuyo extremo remoto no sea local, que es
            // lo que de verdad cierra la puerta. Por el cable, usbmux entrega
            // las conexiones del PC como locales, asi que pasan.
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
            // start() es asincrono: si el bind falla, no lo sabremos por el
            // catch sino aqui. Pasa, por ejemplo, sin permiso de Red local.
            listener?.stateUpdateHandler = { [weak self] estado in
                switch estado {
                case .ready:
                    NSLog("Nexo: escuchando por cable (loopback) en el puerto %d", PUERTO_CABLE)
                case .failed(let e):
                    NSLog("Nexo: el puerto de cable fallo: %@", "\(e)")
                    self?.alFalloEscucha?("Puerto del cable fallido: \(e). Revisa Ajustes › Nexo › Red local.")
                case .cancelled:
                    break
                default:
                    break
                }
            }
            listener?.start(queue: .global())
        } catch {
            NSLog("Nexo: no se pudo abrir el puerto de cable: %@", error.localizedDescription)
            alFalloEscucha?("No se pudo abrir el puerto del cable: \(error.localizedDescription)")
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
