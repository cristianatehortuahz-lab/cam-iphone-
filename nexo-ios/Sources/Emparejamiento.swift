import Foundation
import Security

// La clave de acceso del PC, guardada en el Keychain del iPhone.
//
// El emparejamiento ocurre solo por CABLE: el PC manda su clave en el saludo de
// una sesion por usbmux, que ya esta autenticada por el hardware (cable fisico +
// el iPhone escuchando solo en loopback). El iPhone la guarda y a partir de ahi
// puede volver a ese PC por WiFi presentandola.
//
// Por que asi: el transporte por WiFi escucha en toda la red local, y sin clave
// cualquiera podria ocupar la sesion o meter su propio video en el estudio. Y
// hacerlo por cable evita pedirle al usuario que teclee nada, que es justo lo
// que Nexo promete no hacer.

enum Emparejamiento {
    private static let servicio = "com.nexo.camara"
    private static let cuenta = "clave-pc"

    private static var consultaBase: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicio,
            kSecAttrAccount as String: cuenta,
        ]
    }

    // Guarda (o reemplaza) la clave. Si el PC regenera su clave.txt, el saludo
    // por cable trae la nueva y esta la pisa.
    static func guardar(_ clave: String) {
        guard let datos = clave.data(using: .utf8) else { return }
        _ = SecItemDelete(consultaBase as CFDictionary)

        var nuevo = consultaBase
        nuevo[kSecValueData as String] = datos
        // Solo accesible con el dispositivo desbloqueado, y sin viajar a copias
        // de seguridad ni a otros dispositivos: es una credencial de esta pareja
        // iPhone-PC, no algo que deba seguir al usuario.
        nuevo[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        let estado = SecItemAdd(nuevo as CFDictionary, nil)
        if estado != errSecSuccess {
            NSLog("Nexo: no se pudo guardar la clave de emparejamiento (%d)", estado)
        }
    }

    static func leer() -> String? {
        var consulta = consultaBase
        consulta[kSecReturnData as String] = true
        consulta[kSecMatchLimit as String] = kSecMatchLimitOne

        var resultado: CFTypeRef?
        guard SecItemCopyMatching(consulta as CFDictionary, &resultado) == errSecSuccess,
              let datos = resultado as? Data,
              let clave = String(data: datos, encoding: .utf8),
              !clave.isEmpty
        else { return nil }
        return clave
    }

    static var hayPareja: Bool { leer() != nil }

    static func olvidar() {
        _ = SecItemDelete(consultaBase as CFDictionary)
    }
}
