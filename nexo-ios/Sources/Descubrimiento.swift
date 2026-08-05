import Foundation
import Network

// Busca PCs con Nexo en la red WiFi (servicio _nexo._tcp que anuncia
// descubrimiento.js en el PC). Se usa solo para la ruta WiFi; por cable no hace
// falta descubrir nada. Con NWBrowser, la API moderna de Network.

struct PCNexo: Identifiable, Equatable {
    let id: String       // nombre del servicio
    let nombre: String
    let endpoint: NWEndpoint
}

final class BuscadorPC {
    private var browser: NWBrowser?
    var alCambio: (([PCNexo]) -> Void)?
    private(set) var encontrados: [PCNexo] = []

    func iniciar() {
        let params = NWParameters()
        params.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "_nexo._tcp", domain: nil), using: params)

        browser.browseResultsChangedHandler = { [weak self] resultados, _ in
            guard let self = self else { return }
            self.encontrados = resultados.compactMap { r in
                if case let .service(name, _, _, _) = r.endpoint {
                    return PCNexo(id: name, nombre: name, endpoint: r.endpoint)
                }
                return nil
            }
            self.alCambio?(self.encontrados)
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    func detener() {
        browser?.cancel()
        browser = nil
    }
}
