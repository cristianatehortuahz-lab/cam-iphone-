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
const clave = require('./clave');

// Plazo para que el otro extremo se presente. Sin esto, cualquiera puede abrir
// una conexion y quedarse mudo ocupando el sitio (la sesion es unica).
const PLAZO_SALUDO = 5000;

// Capacidades que anuncia el PC en su saludo. El iPhone las lee para saber que
// entiende este receptor.
const CAPACIDADES_PC = {
  rol: 'receptor',
  app: 'Nexo Desktop',
  codecs: ['h264', 'aac'],
};

class Sesion extends EventEmitter {
  // exigirClave: solo por WiFi. Por cable la conexion ya viene autenticada por
  // el hardware (tunel usbmux + el iPhone escuchando en loopback).
  // sobrante: bytes del flujo que venian pegados a la respuesta de usbmux.
  constructor(socket, { origen = 'desconocido', exigirClave = false, sobrante = null } = {}) {
    super();
    this.socket = socket;
    this.origen = origen; // 'cable' | 'wifi'
    this.capacidadesMovil = null;
    this.ultimoLatido = Date.now();
    // Diferencia entre el reloj del movil y el del PC, en milisegundos. Null
    // hasta la primera medida buena.
    this.desfase = null;
    this.mejorIdaVuelta = null;
    this.ultimaIdaVuelta = null;
    this.cerrada = false;
    this.finEmitido = false;
    this.autenticada = !exigirClave;

    this.analizador = new proto.Analizador({
      onSaludo: ({ capacidades }) => this.#saludo(capacidades, exigirClave),
      onTrama: (t) => this.#trama(t),
      onError: (e) => {
        this.emit('error', e);
        // Un flujo que incumple el protocolo no se recupera: se corta.
        if (e.fatal) this.cerrar();
      },
    });

    socket.on('data', (d) => this.analizador.feed(d));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('close', () => {
      // Aqui, y no solo en cerrar(): si el socket muere solo y nadie llama a
      // cerrar(), el latido seguiria disparando cada 2 s para siempre.
      this.#pararTemporizadores();
      this.cerrada = true;
      // 'fin' sale SIEMPRE y una sola vez, la cierre quien la cierre. Si se lo
      // tragara cuando cerramos nosotros, quien nos adopto se quedaria con una
      // sesion muerta a la que sigue viendo viva, y no reconectaria jamas.
      if (this.finEmitido) return;
      this.finEmitido = true;
      this.emit('fin');
    });

    // Nos presentamos en cuanto se abre. Por cable incluimos la clave para que
    // el iPhone quede emparejado y pueda volver luego por WiFi sin que el
    // usuario teclee nada. Por WiFi NO se manda: seria regalarsela a cualquiera
    // que abra una conexion.
    const capacidades = { ...CAPACIDADES_PC };
    if (origen === 'cable') {
      const k = clave.obtener();
      if (k) capacidades.clave = k;
    }
    socket.write(proto.codificarSaludo(capacidades));

    this.plazoSaludo = setTimeout(() => {
      this.emit('error', new Error(`El otro extremo no se presento en ${PLAZO_SALUDO} ms`));
      this.cerrar();
    }, PLAZO_SALUDO);

    // Latido cada 2 s para mantener vivo y medir ida y vuelta.
    this.latido = setInterval(() => this.enviarLatido(), 2000);

    // Los bytes que llegaron pegados a la respuesta plist son ya del flujo.
    if (sobrante && sobrante.length) this.analizador.feed(sobrante);
  }

  #saludo(capacidades, exigirClave) {
    if (exigirClave && !clave.coincide(capacidades?.clave)) {
      this.emit('rechazada', new Error('Saludo sin clave valida'));
      this.cerrar();
      return;
    }
    clearTimeout(this.plazoSaludo);
    this.autenticada = true;
    this.capacidadesMovil = capacidades;
    this.emit('listo', capacidades);
  }

  #pararTemporizadores() {
    clearInterval(this.latido);
    clearTimeout(this.plazoSaludo);
  }

  #trama(t) {
    switch (t.nombre) {
      case 'video':
        this.emit('video', { microsegundos: t.microsegundos, clave: t.clave, datos: t.datos });
        break;
      case 'audio':
        this.emit('audio', { microsegundos: t.microsegundos, clave: t.clave, datos: t.datos });
        break;
      case 'estado':
        this.emit('estado', t.obj);
        break;
      case 'latido':
        this.ultimoLatido = Date.now();
        this.#medirDesfase(t.obj);
        this.emit('latido');
        break;
    }
  }

  // Orden del PC al movil: cambiar lente, zoom, exposicion, foco, linterna...
  enviarControl(orden) {
    if (!this.autenticada || this.cerrada) return;
    this.socket.write(proto.codificarJson(proto.TRAMA.CONTROL, orden));
  }

  // El latido lleva la hora del PC. El movil la devuelve junto a la suya, y con
  // la ida y vuelta se calcula el desfase entre relojes al estilo NTP.
  //
  // Hace falta para alinear varias camaras: cada iPhone marca sus fotogramas con
  // SU reloj, asi que sin esto no hay forma de saber que fotograma de una
  // corresponde a cual de otra. El tipo LATIDO ya existia y viajaba vacio; el
  // comentario del protocolo decia que medía la latencia y no medía nada.
  enviarLatido() {
    if (this.cerrada) return;
    try {
      this.socket.write(proto.codificarJson(proto.TRAMA.LATIDO, { pc: Date.now() }));
    } catch {
      /* socket cerrandose */
    }
  }

  // Respuesta del movil: {pc: lo que le mandamos, movil: su reloj}.
  #medirDesfase(obj) {
    if (!obj || typeof obj.pc !== 'number' || typeof obj.movil !== 'number') return;
    const ahora = Date.now();
    const ida = ahora - obj.pc;
    if (ida < 0 || ida > 2000) return; // respuesta absurda o muy tardia

    // Se reparte el viaje a partes iguales, que por cable es mas que suficiente.
    const desfase = obj.movil + ida / 2 - ahora;
    this.ultimaIdaVuelta = ida;

    // Nos quedamos con la medida de MENOR ida y vuelta: es la menos contaminada
    // por un pico de la red o del propio movil.
    if (this.mejorIdaVuelta === null || ida < this.mejorIdaVuelta) {
      this.mejorIdaVuelta = ida;
      this.desfase = Math.round(desfase);
      this.emit('desfase', { desfase: this.desfase, idaVuelta: ida });
    }
  }

  // Idempotente: se llama desde varios sitios (rechazo, error fatal, salida).
  cerrar() {
    if (this.cerrada) return;
    this.cerrada = true;
    this.#pararTemporizadores();
    this.socket.destroy();
  }
}

// --- Origen: cable (usbmux) -------------------------------------------------

// Abre el tunel al iPhone por USB y crea la sesion. `puerto` es el que la app
// Nexo Cam escucha en el telefono.
async function conectarCable(deviceID, puerto) {
  const { socket, sobrante } = await usbmux.conectar(deviceID, puerto);
  // Sin clave: el cable ya autentica. El `sobrante` son bytes del flujo que
  // usbmux entrego pegados a su respuesta; se los damos al analizador.
  return new Sesion(socket, { origen: 'cable', sobrante });
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
//
// Aqui escucha toda la red local, asi que la clave NO es opcional: sin ella
// cualquiera en la misma WiFi podria ocupar la sesion y meter su propio video
// en el estudio (y de ahi a OBS). El iPhone la aprende al conectarse por cable.
function servidorWifi(puerto = 7677) {
  const emisor = new EventEmitter();
  const server = net.createServer((socket) => {
    emisor.emit('sesion', new Sesion(socket, { origen: 'wifi', exigirClave: true }));
  });
  server.on('error', (e) => emisor.emit('error', e));
  server.listen(puerto, '0.0.0.0', () => emisor.emit('escuchando', puerto));
  emisor.detener = () => server.close();
  return emisor;
}

module.exports = { Sesion, conectarCable, conectarPrimerCable, servidorWifi, CAPACIDADES_PC };
