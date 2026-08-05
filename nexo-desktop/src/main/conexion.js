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
    this.reintento = null;
    this.servidorWifi = null;
    this.anunciante = null;

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
    this.servidorWifi.on('sesion', (ses) => this.#adoptarSesion(ses, 'wifi'));

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
    if (this.sesion && this.origen === 'cable') return; // ya conectados
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
      this.#adoptarSesion(ses, 'cable');
    } catch (e) {
      // Es normal: usbmux lista el iPhone en cuanto lo enchufas, pero la app
      // Nexo Cam tarda unos segundos en abrir el puerto. Reintentamos.
      if (!/rechazo|puerto/i.test(e.message)) console.error('[nexo] sondeo cable:', e.message);
    }
  }

  #adoptarSesion(nueva, origen) {
    if (this.sesion) return; // ya hay una activa, ignoramos la otra ruta
    this.sesion = nueva;
    this.origen = origen;
    console.log('[nexo] sesion abierta por', origen);
    this.#publicar('sesion-abierta');

    nueva.on('listo', (capacidades) => {
      this.#publicar('movil-listo', { capacidades, origen });
    });
    nueva.on('estado', (estado) => this.#publicar('estado-movil', estado));
    nueva.on('video', (v) => {
      // Reenvio al renderer. En 12 Mbps son ~1,5 MB/s de NAL ya comprimidos:
      // el IPC de Electron lo absorbe sin problema notable.
      this.ipcVideo(v);
    });
    nueva.on('fin', () => {
      console.log('[nexo] sesion cerrada');
      this.sesion = null;
      this.origen = null;
      this.#publicar('sesion-cerrada');
      // Si fue por cable y el iPhone sigue enchufado, el sondeo reconectara solo.
    });
    nueva.on('error', (e) => console.error('[nexo] sesion:', e.message));
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
