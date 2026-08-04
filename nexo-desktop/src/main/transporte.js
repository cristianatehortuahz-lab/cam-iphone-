'use strict';

// El transporte de Nexo. Envuelve un socket duplex —venga del tunel USB
// (usbmux.conectar) o de una conexion WiFi— y habla el protocolo binario: emite
// los fotogramas y el estado que llegan del iPhone, y permite mandarle ordenes.
//
// Es agnostico del origen del socket: esa es la clave para que el cable y el
// WiFi compartan exactamente el mismo codigo por encima.

const { EventEmitter } = require('events');
const net = require('net');
const usbmux = require('./usbmux');
const proto = require('./protocolo');

// Capacidades que anuncia el PC en su saludo. El iPhone las lee para saber que
// entiende este receptor.
const CAPACIDADES_PC = {
  rol: 'receptor',
  app: 'Nexo Desktop',
  codecs: ['h264', 'aac'],
};

class Sesion extends EventEmitter {
  constructor(socket, { origen = 'desconocido' } = {}) {
    super();
    this.socket = socket;
    this.origen = origen; // 'cable' | 'wifi'
    this.capacidadesMovil = null;
    this.ultimoLatido = Date.now();

    this.analizador = new proto.Analizador({
      onSaludo: ({ capacidades }) => {
        this.capacidadesMovil = capacidades;
        this.emit('listo', capacidades);
      },
      onTrama: (t) => this.#trama(t),
      onError: (e) => this.emit('error', e),
    });

    socket.on('data', (d) => this.analizador.feed(d));
    socket.on('close', () => this.emit('fin'));
    socket.on('error', (e) => this.emit('error', e));

    // Nos presentamos en cuanto se abre.
    socket.write(proto.codificarSaludo(CAPACIDADES_PC));

    // Latido cada 2 s para mantener vivo y medir ida y vuelta.
    this.latido = setInterval(() => this.enviarLatido(), 2000);
  }

  #trama(t) {
    switch (t.nombre) {
      case 'video':
        this.emit('video', { microsegundos: t.microsegundos, datos: t.datos });
        break;
      case 'audio':
        this.emit('audio', { microsegundos: t.microsegundos, datos: t.datos });
        break;
      case 'estado':
        this.emit('estado', t.obj);
        break;
      case 'latido':
        this.ultimoLatido = Date.now();
        this.emit('latido');
        break;
    }
  }

  // Orden del PC al movil: cambiar lente, zoom, exposicion, foco, linterna...
  enviarControl(orden) {
    this.socket.write(proto.codificarJson(proto.TRAMA.CONTROL, orden));
  }

  enviarLatido() {
    try {
      this.socket.write(proto.codificarTrama(proto.TRAMA.LATIDO));
    } catch {
      /* socket cerrandose */
    }
  }

  cerrar() {
    clearInterval(this.latido);
    this.socket.destroy();
  }
}

// --- Origen: cable (usbmux) -------------------------------------------------

// Abre el tunel al iPhone por USB y crea la sesion. `puerto` es el que la app
// Nexo Cam escucha en el telefono.
async function conectarCable(deviceID, puerto) {
  const socket = await usbmux.conectar(deviceID, puerto);
  return new Sesion(socket, { origen: 'cable' });
}

// Busca el primer iPhone conectado y se conecta a el.
async function conectarPrimerCable(puerto) {
  const dispositivos = await usbmux.listarDispositivos();
  if (dispositivos.length === 0) throw new Error('No hay ningun iPhone conectado por cable.');
  return conectarCable(dispositivos[0].deviceID, puerto);
}

// --- Origen: WiFi -----------------------------------------------------------

// El PC escucha; el iPhone (que encuentra al PC por Bonjour) se conecta. Cada
// conexion entrante se envuelve en una Sesion y se anuncia con 'sesion'.
function servidorWifi(puerto = 7677) {
  const emisor = new EventEmitter();
  const server = net.createServer((socket) => {
    emisor.emit('sesion', new Sesion(socket, { origen: 'wifi' }));
  });
  server.on('error', (e) => emisor.emit('error', e));
  server.listen(puerto, '0.0.0.0', () => emisor.emit('escuchando', puerto));
  emisor.detener = () => server.close();
  return emisor;
}

module.exports = { Sesion, conectarCable, conectarPrimerCable, servidorWifi, CAPACIDADES_PC };
