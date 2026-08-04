'use strict';

// Certificados en dos niveles.
//
// El problema que resuelve: si generas un unico certificado autofirmado por IP,
// cada vez que cambia la red (conectar el cable anade 172.20.10.x) hay que
// generarlo de nuevo, y el que instalaste en el iPhone deja de valer.
//
// La solucion: una CA raiz que se crea UNA vez y no cambia nunca -- esa es la
// que instalas en el iPhone -- y certificados de servidor firmados por ella,
// que se pueden regenerar libremente cada vez que cambien las IPs. Instalas una
// sola vez y el telefono confia en todo lo que venga firmado por esa CA.

const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const DIAS_CA = 3650; // la raiz puede durar mucho: no viaja a ningun sitio
// iOS rechaza certificados de servidor de mas de 398 dias. Como notBefore lleva
// un dia de margen hacia atras, 395 deja la validez total en 396: dentro con
// holgura, sin quedarnos justo en el limite.
const DIAS_SERVIDOR = 395;

function serieAleatoria() {
  // Un byte inicial >= 0x80 se interpretaria como numero negativo, de ahi el 00.
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function fechas(dias) {
  const desde = new Date();
  desde.setDate(desde.getDate() - 1); // margen por relojes desfasados
  const hasta = new Date();
  hasta.setDate(hasta.getDate() + dias);
  return { desde, hasta };
}

function crearCA() {
  const claves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const { desde, hasta } = fechas(DIAS_CA);

  const sujeto = [
    { name: 'commonName', value: 'Camara iPhone CA' },
    { name: 'organizationName', value: 'Camara iPhone' },
  ];

  cert.publicKey = claves.publicKey;
  cert.serialNumber = serieAleatoria();
  cert.validity.notBefore = desde;
  cert.validity.notAfter = hasta;
  cert.setSubject(sujeto);
  cert.setIssuer(sujeto); // autofirmada: es la raiz
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(claves.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(claves.privateKey),
  };
}

function crearServidor(caPem, caKeyPem, ips) {
  const caCert = forge.pki.certificateFromPem(caPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  const claves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const { desde, hasta } = fechas(DIAS_SERVIDOR);

  cert.publicKey = claves.publicKey;
  cert.serialNumber = serieAleatoria();
  cert.validity.notBefore = desde;
  cert.validity.notAfter = hasta;
  cert.setSubject([{ name: 'commonName', value: 'Camara iPhone' }]);
  cert.setIssuer(caCert.subject.attributes);

  // iOS exige que el nombre valido este en subjectAltName; el commonName solo
  // ya no le sirve desde hace varias versiones.
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(claves.privateKey),
  };
}

// Devuelve el material listo para arrancar el servidor, creando solo lo que
// falte. La CA se conserva siempre; el certificado de servidor se rehace en
// cuanto cambian las IPs, sin que eso afecte a la confianza ya instalada.
function preparar(directorio, ips) {
  const f = (n) => path.join(directorio, n);
  fs.mkdirSync(directorio, { recursive: true });

  let caNueva = false;
  if (!fs.existsSync(f('ca.crt')) || !fs.existsSync(f('ca.key'))) {
    console.log('  Creando la autoridad raiz (solo ocurre una vez)...');
    const ca = crearCA();
    fs.writeFileSync(f('ca.crt'), ca.cert);
    fs.writeFileSync(f('ca.key'), ca.key);
    caNueva = true;
  }

  const caPem = fs.readFileSync(f('ca.crt'), 'utf8');
  const caKeyPem = fs.readFileSync(f('ca.key'), 'utf8');

  const ordenadas = ips.slice().sort();
  let hayQueEmitir = true;
  if (!caNueva && fs.existsSync(f('servidor.crt')) && fs.existsSync(f('servidor.key'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(f('meta.json'), 'utf8'));
      const cert = forge.pki.certificateFromPem(fs.readFileSync(f('servidor.crt'), 'utf8'));
      const caduca = cert.validity.notAfter.getTime() - Date.now() < 7 * 24 * 3600 * 1000;
      hayQueEmitir = (meta.ips || []).join(',') !== ordenadas.join(',') || caduca;
      if (hayQueEmitir && !caduca) {
        console.log('  Las IPs cambiaron: reemitiendo el certificado de servidor.');
        console.log('  No hace falta tocar el iPhone: la raiz instalada sigue valiendo.');
      }
    } catch {
      hayQueEmitir = true;
    }
  }

  if (hayQueEmitir) {
    const s = crearServidor(caPem, caKeyPem, ips);
    fs.writeFileSync(f('servidor.crt'), s.cert);
    fs.writeFileSync(f('servidor.key'), s.key);
    fs.writeFileSync(f('meta.json'), JSON.stringify({ ips: ordenadas, emitido: new Date().toISOString() }, null, 2));
  }

  return {
    ca: caPem,
    cert: fs.readFileSync(f('servidor.crt')),
    key: fs.readFileSync(f('servidor.key')),
    caNueva,
    reemitido: hayQueEmitir,
  };
}

module.exports = { preparar };
