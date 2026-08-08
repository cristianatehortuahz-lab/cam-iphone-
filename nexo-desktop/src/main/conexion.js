'use strict';

// Orquestador de la conexion nativa con Nexo Cam. Es lo que faltaba de F3.5:
// cablea las piezas del transporte (usbmux, protocolo, WiFi/Bonjour) al proceso
// principal y las expone al renderer via IPC.
//
//   Escucha eventos:  'estado' | 'sesion' | 'video' | 'perdida'
//   Publica IPC:      nexo:conexion:estado, nexo:conexion:video

const { EventEmitter } = require('events');
const usbmux = require('./usbmux');
const transporte = require('./transporte');
const { Anunciante } = require('./descubrimiento');
const { CABLE_IPHONE, WIFI } = require('./puertos');

const INTERVALO_SONDEO = 2000; // ms entre comprobaciones de usbmux

class Conexion extends EventEmitter {
  constructor({ ipcVideo } = {}) {
    super();
    this.sesion = null;
    this.origen = null; // 'cable' | 'wifi' | null
    this.dispositivoID = null;
    this.hayUsbmux = false;
    this.hayCable = false;
    this.temporizadorSondeo = null;
    this.sondeando = false;
    this.reintento = null;
    this.servidorWifi = null;
    this.anunciante = null;
    this.ultimoEstadoMovil = null;

    // Callback para reenviar cada NAL de video al renderer. Se separa asi para
    // no acoplar este modulo a Electron: en pruebas se puede pasar cualquier fn.
    this.ipcVideo = ipcVideo || (() => {});
  }

  async iniciar() {
    // Ruta cable: sondea usbmux. Sin iPhone conectado no se hace nada; en cuanto
    // aparece, se abre el tunel y se conecta.
    this.hayUsbmux = await usbmux.disponible();
    if (!this.hayUsbmux) {
      this.#publicar('sin-usbmux');
      // No es fatal: puede que solo tengas WiFi. Seguimos.
    }
    this.temporizadorSondeo = setInterval(() => this.#sondearCable(), INTERVALO_SONDEO);
    this.#sondearCable(); // primer intento inmediato

    // Ruta WiFi: escuchar en el puerto Nexo y anunciarse por Bonjour.
    this.servidorWifi = transporte.servidorWifi(WIFI);
    this.servidorWifi.on('escuchando', (p) => console.log('[nexo] WiFi escucha en', p));
    this.servidorWifi.on('error', (e) => console.error('[nexo] servidor WiFi:', e.message));
    this.servidorWifi.on('sesion', (ses) => this.#considerarSesion(ses, 'wifi'));

    try {
      this.anunciante = new Anunciante();
      this.anunciante.anunciar(WIFI);
      console.log('[nexo] anunciado por Bonjour en el puerto', WIFI);
    } catch (e) {
      console.error('[nexo] Bonjour:', e.message);
    }

    this.#publicar('listo');
  }

  async #sondearCable() {
    // Cualquier sesion activa, no solo la de cable: si hay una sesion WiFi
    // abierta y solo miraramos 'cable', abririamos un tunel usbmux nuevo cada
    // 2 s que luego se descarta — un socket y un temporizador filtrados por
    // sondeo, indefinidamente.
    if (this.sesion) return;
    // El sondeo es asincrono y el intervalo no espera: sin esto, dos sondeos
    // solapados pueden abrir dos tuneles.
    if (this.sondeando) return;
    this.sondeando = true;
    try {
      const dispositivos = await usbmux.listarDispositivos();
      const primero = dispositivos[0] || null;

      // Publicar cambios de estado del cable (para la interfaz).
      const habia = this.hayCable;
      this.hayCable = Boolean(primero);
      if (habia !== this.hayCable) this.#publicar(this.hayCable ? 'cable-detectado' : 'cable-quitado');

      if (!primero) return;
      this.dispositivoID = primero.deviceID;

      // Intentar abrir el tunel.
      const ses = await transporte.conectarCable(primero.deviceID, CABLE_IPHONE);
      this.#considerarSesion(ses, 'cable');
    } catch (e) {
      // Es normal: usbmux lista el iPhone en cuanto lo enchufas, pero la app
      // Nexo Cam tarda unos segundos en abrir el puerto. Reintentamos.
      if (!/rechazo|puerto/i.test(e.message)) console.error('[nexo] sondeo cable:', e.message);
    } finally {
      this.sondeando = false;
    }
  }

  // Una conexion recien abierta todavia no es "la" sesion: solo lo sera cuando
  // se presente con un saludo valido (y, por WiFi, con la clave correcta). Asi
  // una conexion muda o ajena no ocupa el hueco del iPhone real.
  #considerarSesion(nueva, origen) {
    if (this.sesion) {
      // Sobra. Cerrarla de verdad: antes se descartaba con un `return` seco y
      // se quedaba el socket abierto y el latido latiendo para siempre.
      nueva.cerrar();
      return;
    }

    nueva.on('rechazada', (e) =>
      console.warn(`[nexo] conexion ${origen} rechazada: ${e.message}`)
    );
    nueva.on('error', (e) => console.error('[nexo] sesion:', e.message));

    nueva.once('listo', (capacidades) => {
      if (this.sesion) return nueva.cerrar(); // otra ruta gano la carrera
      this.#adoptarSesion(nueva, origen, capacidades);
    });
  }

  #adoptarSesion(nueva, origen, capacidades) {
    this.sesion = nueva;
    this.origen = origen;
    console.log('[nexo] sesion abierta por', origen);
    this.#publicar('sesion-abierta');
    this.#publicar('movil-listo', { capacidades, origen });

    nueva.on('estado', (estado) => {
      // Se guarda porque el iPhone publica su estado al conectar y luego solo
      // cuando algo cambia. La sesion puede abrirse antes de que exista la
      // ventana, y entonces ese unico envio —con la lista de lentes— se
      // perderia y el estudio se quedaria sin selector para siempre.
      this.ultimoEstadoMovil = estado;
      this.#publicar('estado-movil', estado);
    });
    nueva.on('video', (v) => {
      // Reenvio al renderer. En 12 Mbps son ~1,5 MB/s de NAL ya comprimidos:
      // el IPC de Electron lo absorbe sin problema notable.
      this.ipcVideo(v);
    });
    nueva.once('fin', () => {
      console.log('[nexo] sesion cerrada');
      // cerrar() ademas de soltar la referencia: para el latido y destruye el
      // socket aunque el cierre no viniera de nosotros.
      nueva.cerrar();
      this.sesion = null;
      this.origen = null;
      this.ultimoEstadoMovil = null;
      this.#publicar('sesion-cerrada');
      // Si fue por cable y el iPhone sigue enchufado, el sondeo reconectara solo.
    });
  }

  // Reenvia una orden del PC al iPhone (cambiar lente, zoom, etc.).
  enviarControl(orden) {
    if (this.sesion) this.sesion.enviarControl(orden);
  }

  estado() {
    return {
      hayUsbmux: this.hayUsbmux,
      hayCable: this.hayCable,
      dispositivoID: this.dispositivoID,
      conectado: Boolean(this.sesion),
      origen: this.origen,
      estadoMovil: this.ultimoEstadoMovil || null,
    };
  }

  #publicar(evento, datos) {
    this.emit('cambio', { evento, datos, estado: this.estado() });
  }

  async detener() {
    clearInterval(this.temporizadorSondeo);
    clearTimeout(this.reintento);
    if (this.sesion) this.sesion.cerrar();
    if (this.servidorWifi) this.servidorWifi.detener();
    if (this.anunciante) this.anunciante.cerrar();
  }
}

module.exports = { Conexion };
