import Foundation

// Protocolo binario de Nexo, lado iPhone. Es el espejo EXACTO de
// nexo-desktop/src/main/protocolo.js — cualquier cambio debe hacerse en ambos.
//
//   Saludo:  "NEXO1"(5) | version u8 | longitud u32-BE | JSON de capacidades
//   Trama:   tipo u8 | longitud u32-BE | carga
//   Media:   u64-BE tiempo (us) | u8 flags (bit 0 = clave) | datos
//
//   Tipos:   1 VIDEO  2 AUDIO  3 ESTADO  4 CONTROL  5 LATIDO

enum TipoTrama: UInt8 {
    case video = 1
    case audio = 2
    case estado = 3
    case control = 4
    case latido = 5
}

enum ProtocoloNexo {
    static let magia = Data("NEXO1".utf8)
    static let version: UInt8 = 1

    // Techo de tamano de trama. Sin limite, un par puede declarar 4 GB en el u32
    // de longitud y gotear bytes hasta agotar la memoria. Debe coincidir con
    // MAX_TRAMA en nexo-desktop/src/main/protocolo.js.
    static let maxTrama = 4 * 1024 * 1024

    // --- Escritura de enteros en big-endian ---------------------------------

    private static func u32BE(_ v: UInt32) -> Data {
        var be = v.bigEndian
        return withUnsafeBytes(of: &be) { Data($0) }
    }

    private static func u64BE(_ v: UInt64) -> Data {
        var be = v.bigEndian
        return withUnsafeBytes(of: &be) { Data($0) }
    }

    // --- Codificar ----------------------------------------------------------

    static func codificarSaludo(_ capacidades: [String: Any]) -> Data {
        let json = (try? JSONSerialization.data(withJSONObject: capacidades)) ?? Data("{}".utf8)
        var d = Data()
        d.append(magia)
        d.append(version)
        d.append(u32BE(UInt32(json.count)))
        d.append(json)
        return d
    }

    static func codificarTrama(_ tipo: TipoTrama, _ carga: Data) -> Data {
        var d = Data()
        d.append(tipo.rawValue)
        d.append(u32BE(UInt32(carga.count)))
        d.append(carga)
        return d
    }

    // Video/audio: marca de tiempo + byte de flags + datos. Bit 0 de flags =
    // fotograma clave (imprescindible: sin el, el decodificador del PC se
    // queda esperando la primera IDR y no se ve nada).
    static func codificarMedia(_ tipo: TipoTrama, microsegundos: UInt64,
                               clave: Bool = false, datos: Data) -> Data {
        var carga = u64BE(microsegundos)
        // UInt8 explicito: `append(clave ? 1 : 0)` deja que Swift elija entre
        // varias sobrecargas de Data.append segun como infiera el literal, y el
        // byte de flags llegaba a cero al PC. Aqui no hay nada que inferir.
        carga.append(UInt8(clave ? 1 : 0))
        carga.append(datos)
        return codificarTrama(tipo, carga)
    }

    static func codificarJson(_ tipo: TipoTrama, _ obj: [String: Any]) -> Data {
        let json = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        return codificarTrama(tipo, json)
    }

    static func codificarLatido() -> Data {
        codificarTrama(.latido, Data())
    }
}

// Analizador de flujo: acumula bytes y va extrayendo el saludo y luego las
// tramas completas. Espejo de la clase Analizador de protocolo.js. TCP entrega
// los bytes troceados, asi que hay que reensamblar.
final class AnalizadorNexo {
    private var buffer = Data()
    private var saludoHecho = false
    // Un flujo que incumple el protocolo no se recupera: se marca roto y se deja
    // de leer. Quien nos alimenta cierra la conexion al recibir alError.
    private(set) var roto = false

    var alSaludo: ((_ version: UInt8, _ capacidades: [String: Any]) -> Void)?
    var alControl: ((_ orden: [String: Any]) -> Void)?
    var alLatido: (() -> Void)?
    var alError: ((String) -> Void)?

    func alimentar(_ trozo: Data) {
        guard !roto else { return }
        buffer.append(trozo)
        while true {
            if !saludoHecho {
                if !leerSaludo() { break }
            } else if !leerTrama() {
                break
            }
        }
    }

    // Corta el flujo para siempre y avisa. Devuelve false para cortar el bucle.
    private func romper(_ mensaje: String) -> Bool {
        roto = true
        buffer.removeAll()
        alError?(mensaje)
        return false
    }

    private func leerU32BE(_ offset: Int) -> UInt32 {
        var v: UInt32 = 0
        for i in 0..<4 { v = (v << 8) | UInt32(buffer[buffer.startIndex + offset + i]) }
        return v
    }

    private func leerSaludo() -> Bool {
        let minimo = ProtocoloNexo.magia.count + 1 + 4
        guard buffer.count >= minimo else { return false }

        let cabeceraMagia = buffer.subdata(in: buffer.startIndex..<(buffer.startIndex + ProtocoloNexo.magia.count))
        guard cabeceraMagia == ProtocoloNexo.magia else {
            return romper("Saludo invalido: no es un flujo Nexo")
        }
        let lonJson = Int(leerU32BE(ProtocoloNexo.magia.count + 1))
        guard lonJson <= ProtocoloNexo.maxTrama else {
            return romper("Saludo de \(lonJson) bytes: supera el maximo de \(ProtocoloNexo.maxTrama)")
        }
        guard buffer.count >= minimo + lonJson else { return false }

        let inicio = buffer.startIndex + minimo
        let jsonData = buffer.subdata(in: inicio..<(inicio + lonJson))
        let caps = (try? JSONSerialization.jsonObject(with: jsonData)) as? [String: Any] ?? [:]
        let version = buffer[buffer.startIndex + ProtocoloNexo.magia.count]

        buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + minimo + lonJson))
        saludoHecho = true
        alSaludo?(version, caps)
        return true
    }

    private func leerTrama() -> Bool {
        guard buffer.count >= 5 else { return false }
        let tipo = buffer[buffer.startIndex]
        let longitud = Int(leerU32BE(1))
        guard longitud <= ProtocoloNexo.maxTrama else {
            return romper("Trama de \(longitud) bytes: supera el maximo de \(ProtocoloNexo.maxTrama)")
        }
        guard buffer.count >= 5 + longitud else { return false }

        let inicio = buffer.startIndex + 5
        let carga = buffer.subdata(in: inicio..<(inicio + longitud))
        buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + 5 + longitud))

        switch TipoTrama(rawValue: tipo) {
        case .control:
            if let obj = (try? JSONSerialization.jsonObject(with: carga)) as? [String: Any] {
                alControl?(obj)
            }
        case .latido:
            alLatido?()
        default:
            break // el iPhone es el emisor: no espera video/audio/estado entrante
        }
        return true
    }
}
