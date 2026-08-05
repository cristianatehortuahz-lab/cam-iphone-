'use strict';

// Puertos usados por Nexo. Fuente unica para que el PC y la app iOS no se
// desincronicen. Si cambia aqui, hay que cambiarlo tambien en
// nexo-ios/Sources/Transporte.swift (PUERTO_CABLE).

module.exports = {
  // Puerto que la app Nexo Cam abre en el iPhone. El PC llega a el por usbmux.
  CABLE_IPHONE: 7000,
  // Puerto del servidor Nexo por WiFi (el PC escucha, el iPhone se conecta).
  WIFI: 7677,
};
