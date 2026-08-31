'use strict';

// La clave de acceso de Nexo, compartida entre el servidor legado (navegador) y
// el transporte nativo. Es un unico `clave.txt`: si el usuario ya emparejo el
// iPhone por el navegador, la misma clave vale para la ruta nativa y al reves.
//
// El transporte nativo la usa solo por WiFi. Por cable no se pide: el tunel
// usbmux exige cable fisico y el iPhone escucha solo en loopback, asi que la
// conexion ya esta autenticada por el hardware.

const fs = require('fs');
const path = require('path');

// Igual que rutaLegado() en index.js: empaquetado en resources/legado, y en
// desarrollo tres niveles por encima de src/main.
function rutaLegado(archivo) {
  // Solo se mira la ruta empaquetada si de verdad hay una: fuera de Electron,
  // process.resourcesPath es undefined y path.join('', 'legado', archivo) daba
  // una ruta RELATIVA que puede existir segun desde donde se ejecute. Entonces
  // require() la tomaba por el nombre de un modulo y fallaba.
  if (process.resourcesPath) {
    const empaquetado = path.join(process.resourcesPath, 'legado', archivo);
    if (fs.existsSync(empaquetado)) return empaquetado;
  }
  return path.join(__dirname, '..', '..', '..', 'legado', archivo);
}

// Directorio donde el servidor legado guarda clave.txt (server.js: CERT_DIR).
function directorioClave() {
  return rutaLegado('certs');
}

let cache = null;

// Devuelve la clave, creandola la primera vez. Null si no se pudo (por ejemplo
// carpeta sin permisos de escritura): quien llama debe tratarlo como "no puedo
// autenticar" y no como "todo el mundo pasa".
function obtener() {
  if (cache) return cache;
  try {
    const acceso = require(rutaLegado('acceso.js'));
    cache = acceso.cargarClave(directorioClave());
    return cache;
  } catch (e) {
    console.error('[nexo] no se pudo cargar la clave de acceso:', e.message);
    return null;
  }
}

// Comparacion en tiempo constante, con el mismo criterio que la ruta legada.
function coincide(candidata) {
  const real = obtener();
  if (!real) return false;
  try {
    return require(rutaLegado('acceso.js')).iguales(String(candidata ?? ''), real);
  } catch {
    return false;
  }
}

module.exports = { obtener, coincide, rutaLegado };
