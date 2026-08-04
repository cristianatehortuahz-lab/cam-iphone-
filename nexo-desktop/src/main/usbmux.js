'use strict';

// Cliente del demonio usbmux de Apple. Es el que permite que el PC alcance un
// puerto TCP que la app del iPhone abre, viajando por el cable USB. En Windows,
// "Apple Mobile Device Service" expone usbmux en 127.0.0.1:27015; en Mac/Linux
// seria un socket unix. Es el mismo mecanismo que usan iTunes y Camo.
//
// Protocolo: mensajes con cabecera de 16 bytes + carga en formato plist (XML).
//   cabecera = longitud u32 | version u32 (=1) | tipo u32 (=8, plist) | tag u32
//
// Aqui solo necesitamos dos operaciones:
//   listarDispositivos() -> que iPhones hay conectados
//   conectar(deviceID, puerto) -> un socket ya tunelizado a ese puerto del movil

const net = require('net');

const PUERTO_USBMUX = 27015; // Windows (Apple Mobile Device Service)
const VERSION = 1;
const TIPO_PLIST = 8;

let tagSiguiente = 1;

// --- Construccion y lectura de mensajes ------------------------------------

function envolver(plistXml, tag) {
  const carga = Buffer.from(plistXml, 'utf8');
  const cab = Buffer.alloc(16);
  cab.writeUInt32LE(16 + carga.length, 0);
  cab.writeUInt32LE(VERSION, 4);
  cab.writeUInt32LE(TIPO_PLIST, 8);
  cab.writeUInt32LE(tag, 12);
  return Buffer.concat([cab, carga]);
}

function plist(dict) {
  const cuerpo = Object.entries(dict)
    .map(([k, v]) => {
      const clave = `<key>${k}</key>`;
      if (typeof v === 'number') return `${clave}<integer>${v}</integer>`;
      return `${clave}<string>${v}</string>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
    `<plist version="1.0"><dict>${cuerpo}</dict></plist>`
  );
}

const CLIENTE = { ClientVersionString: 'Nexo', ProgName: 'Nexo', kLibUSBMuxVersion: 3 };

// Envia un mensaje y devuelve { socket, respuesta } con la primera respuesta
// plist. El socket se deja abierto: en Connect exitoso ES el tunel.
function transaccion(dict) {
  return new Promise((resolver, rechazar) => {
    const tag = tagSiguiente++;
    const socket = net.connect(PUERTO_USBMUX, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let listo = false;

    const fallar = (e) => {
      if (!listo) {
        listo = true;
        socket.destroy();
        rechazar(e);
      }
    };

    socket.on('connect', () => socket.write(envolver(plist(dict), tag)));

    socket.on('data', (trozo) => {
      buffer = Buffer.concat([buffer, trozo]);
      if (buffer.length < 16) return;
      const longitud = buffer.readUInt32LE(0);
      if (buffer.length < longitud) return; // aun falta

      const xml = buffer.slice(16, longitud).toString('utf8');
      listo = true;
      resolver({ socket, xml });
    });

    socket.on('error', fallar);
    socket.on('close', () => fallar(new Error('usbmux cerro la conexion. ¿Esta corriendo Apple Mobile Device Service?')));
    setTimeout(() => fallar(new Error('usbmux no respondio (tiempo agotado)')), 4000);
  });
}

// --- Lectura minima de plist (solo lo que necesitamos) ---------------------

// Extrae los dispositivos de una respuesta ListDevices. usbmux formatea el
// plist con saltos de linea y tabuladores entre etiquetas, asi que primero
// quitamos todo el espacio entre '>' y '<' y luego troceamos. En vez de un
// parser completo de plist, sacamos los campos con expresiones simples: es
// robusto para esta forma concreta.
function compactar(xml) {
  return xml.replace(/>\s+</g, '><');
}

function leerDispositivos(xml) {
  const limpio = compactar(xml);
  const dispositivos = [];
  // Cada entrada es <dict>...DeviceID...<key>Properties</key><dict>...</dict></dict>
  const regexEntrada = /<key>DeviceID<\/key><integer>(\d+)<\/integer>(.*?)<\/dict><\/dict>/g;
  let m;
  while ((m = regexEntrada.exec(limpio)) !== null) {
    const deviceID = Number(m[1]);
    const props = m[2];
    const serial = (props.match(/<key>SerialNumber<\/key><string>([^<]*)<\/string>/) || [])[1] || null;
    const tipo = (props.match(/<key>ConnectionType<\/key><string>([^<]*)<\/string>/) || [])[1] || null;
    const producto = (props.match(/<key>ProductID<\/key><integer>(\d+)<\/integer>/) || [])[1] || null;
    dispositivos.push({ deviceID, serial, tipo, producto: producto ? Number(producto) : null });
  }
  return dispositivos;
}

function leerNumero(xml, clave) {
  const m = compactar(xml).match(new RegExp(`<key>${clave}</key><integer>(-?\\d+)</integer>`));
  return m ? Number(m[1]) : null;
}

// --- API --------------------------------------------------------------------

// Lista los iPhone conectados por USB. Array vacio = ninguno enchufado.
async function listarDispositivos() {
  const { socket, xml } = await transaccion({ MessageType: 'ListDevices', ...CLIENTE });
  socket.end();
  return leerDispositivos(xml);
}

// Abre un tunel al puerto TCP que la app iOS escucha en el iPhone. Devuelve un
// net.Socket ya conectado a traves del cable. El puerto va en orden de red.
async function conectar(deviceID, puerto) {
  const puertoRed = ((puerto & 0xff) << 8) | ((puerto >> 8) & 0xff);
  const { socket, xml } = await transaccion({
    MessageType: 'Connect',
    DeviceID: deviceID,
    PortNumber: puertoRed,
    ...CLIENTE,
  });

  const resultado = leerNumero(xml, 'Number');
  if (resultado !== 0) {
    socket.destroy();
    const motivos = { 2: 'el iPhone rechazo la conexion (¿la app Nexo Cam esta abierta?)', 3: 'puerto no disponible', 5: 'dispositivo desconectado' };
    throw new Error(`No se pudo tunelizar al puerto ${puerto}: ${motivos[resultado] || 'codigo ' + resultado}`);
  }
  // A partir de aqui, este socket ES el flujo directo con el iPhone.
  return socket;
}

// Comprueba si usbmux esta accesible (servicio de Apple corriendo).
async function disponible() {
  try {
    await listarDispositivos();
    return true;
  } catch {
    return false;
  }
}

module.exports = { listarDispositivos, conectar, disponible, PUERTO_USBMUX };
