'use strict';

// Orquestador de las conexiones con Nexo Cam. Cablea las piezas del transporte
// (usbmux, protocolo, WiFi/Bonjour) al proceso principal y las expone al
// renderer via IPC.
//
// Admite VARIOS iPhone a la vez, uno por dispositivo: es lo que permite grabar
// una misma toma desde varios angulos. Antes habia un unico hueco de sesion y
// las demas se cerraban nada mas llegar.
//
// De todos los conectados, uno es el "principal": el que se ve en el estudio y
// el que sale a OBS. Todos se graban, se mire el que se mire.

const { EventEmitter } = require('events');
const usbmux = require('./usbmux');
const transporte = require('./transporte');
const { Anunciante } = require('./descubrimiento');
const { CABLE_IPHONE, WIFI } = require('./puertos');

const INTERVALO_SONDEO = 2000; // ms entre comprobaciones de usbmux

class Conexion extends EventEmitter {
  constructor({ ipcVideo, ipcAudio } = {}) {
    super();
    // Una sesion por dispositivo, con su identificador como clave.
    this.sesiones = new Map();
    // Dispositivos con un tunel a medio abrir. El sondeo es asincrono y no
    // espera, asi que sin esto dos vueltas seguidas abren dos tuneles al mismo
    // iPhone.
    this.conectando = new Set();
    this.principal = null;

    this.hayUsbmux = false;
    this.temporizadorSondeo = null;
    this.sondeando = false;
    this.servidorWifi = null;
    this.anunciante = null;

    // Reenvio de media. Llevan el identificador del movil porque con varias
    // camaras hay que saber cual es cual: el grabador escribe un archivo por
    // cada una.
    this.ipcVideo = ipcVideo || (() => {});
    this.ipcAudio = ipcAudio || (() => {});
  }

  async iniciar() {
    this.hayUsbmux = await usbmux.disponible();
    if (!this.hayUsbmux) {
      this.#publicar('sin-usbmux');
      // No es fatal: puede que solo tengas WiFi. Seguimos.
    }
    this.temporizadorSondeo = setInterval(() => this.#sondearCable(), INTERVALO_SONDEO);
    this.#sondearCable(); // primer intento inmediato

    this.servidorWifi = transporte.servidorWifi(WIFI);
    this.servidorWifi.on('escuchando', (p) => console.log('[nexo] WiFi escucha en', p));
    this.servidorWifi.on('error', (e) => console.error('[nexo] servidor WiFi:', e.message));
    this.servidorWifi.on('sesion', (ses) => {
      // Por WiFi no hay identificador hasta el saludo: se usa el extremo remoto,
      // que ya distingue dos moviles distintos.
      const zocalo = ses.socket.remoteAddress + ':' + ses.socket.remotePort;
      this.#considerarSesion(ses, 'wifi', 'wifi-' + zocalo);
    });

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
    if (this.sondeando) return;
    this.sondeando = true;
    try {
      const dispositivos = await usbmux.listarDispositivos();

      const habia = this.hayCable;
      this.hayCable = dispositivos.length > 0;
      if (habia !== this.hayCable) {
        this.#publicar(this.hayCable ? 'cable-detectado' : 'cable-quitado');
      }

      // TODOS los iPhone conectados, no solo el primero: cada uno es un angulo.
      for (const dispositivo of dispositivos) {
        const id = 'cable-' + dispositivo.deviceID;
        if (this.sesiones.has(id) || this.conectando.has(id)) continue;

        this.conectando.add(id);
        try {
          const ses = await transporte.conectarCable(dispositivo.deviceID, CABLE_IPHONE);
          this.#considerarSesion(ses, 'cable', id);
        } catch (e) {
          // Es normal: usbmux lista el iPhone en cuanto lo enchufas, pero Nexo
          // Cam tarda unos segundos en abrir el puerto. Se reintenta al sondeo
          // siguiente.
          if (!/rechazo|puerto/i.test(e.message)) {
            console.error('[nexo] sondeo cable:', e.message);
          }
        } finally {
          this.conectando.delete(id);
        }
      }
    } catch (e) {
      console.error('[nexo] sondeo cable:', e.message);
    } finally {
      this.sondeando = false;
    }
  }

  // Una conexion recien abierta todavia no es una sesion: solo lo sera cuando se
  // presente con un saludo valido (y, por WiFi, con la clave correcta). Asi una
  // conexion muda o ajena no ocupa el sitio de un iPhone de verdad.
  #considerarSesion(nueva, origen, id) {
    if (this.sesiones.has(id)) {
      // Ese dispositivo ya tiene sesion. Cerrarla de verdad: descartarla con un
      // `return` seco dejaba el socket abierto y el latido latiendo para siempre.
      nueva.cerrar();
      return;
    }

    nueva.on('rechazada', (e) => console.warn(`[nexo] conexion ${origen} rechazada: ${e.message}`));
    nueva.on('error', (e) => console.error(`[nexo] sesion ${id}:`, e.message));

    nueva.once('listo', (capacidades) => {
      if (this.sesiones.has(id)) return nueva.cerrar(); // gano otra carrera
      this.#adoptarSesion(nueva, origen, id, capacidades);
    });
  }

  #adoptarSesion(nueva, origen, id, capacidades) {
    const camara = { id, origen, sesion: nueva, capacidades, estadoMovil: null };
    this.sesiones.set(id, camara);
    // El primero que llega manda en el estudio; los demas se graban igual.
    if (!this.principal) this.principal = id;

    console.log(`[nexo] sesion abierta por ${origen} (${id})`);
    this.#publicar('sesion-abierta', { id, origen });
    this.#publicar('movil-listo', { id, capacidades, origen });

    nueva.on('estado', (estado) => {
      // Se guarda porque el iPhone publica su estado al conectar y luego solo
      // cuando algo cambia. La sesion puede abrirse antes de que exista la
      // ventana, y ese unico envio —con la lista de lentes— se perderia.
      camara.estadoMovil = estado;
      this.#publicar('estado-movil', { id, estado });
    });

    nueva.on('audio', (a) => this.ipcAudio(a, id));
    nueva.on('video', (v) => this.ipcVideo(v, id));

    nueva.once('fin', () => {
      console.log(`[nexo] sesion cerrada (${id})`);
      // cerrar() ademas de soltar la referencia: para el latido y destruye el
      // socket aunque el cierre no viniera de nosotros.
      nueva.cerrar();
      this.sesiones.delete(id);
      if (this.principal === id) {
        // Pasa el mando a otra camara si queda alguna.
        this.principal = this.sesiones.keys().next().value || null;
      }
      this.#publicar('sesion-cerrada', { id });
    });
  }

  // Cual se ve en el estudio y sale a OBS. Grabar sigue grabandolas todas.
  elegirPrincipal(id) {
    if (!this.sesiones.has(id)) return false;
    this.principal = id;
    this.#publicar('principal-cambiada', { id });
    return true;
  }

  // Sin id, la orden va a TODAS: util para empezar a grabar o poner la misma
  // resolucion en todos los angulos de una vez.
  enviarControl(orden, id = null) {
    if (id) {
      const camara = this.sesiones.get(id);
      if (camara) camara.sesion.enviarControl(orden);
      return;
    }
    for (const camara of this.sesiones.values()) camara.sesion.enviarControl(orden);
  }

  camaras() {
    return [...this.sesiones.values()].map((c) => ({
      id: c.id,
      origen: c.origen,
      principal: c.id === this.principal,
      // Van las capacidades del saludo porque el grabador nombra los archivos
      // con el modelo del movil. Sin ellas caia al identificador de sesion y los
      // archivos salian como "wifi-127.0.0.1-52076.mp4".
      capacidades: c.capacidades,
      estadoMovil: c.estadoMovil,
      desfase: c.sesion.desfase ?? null,
    }));
  }

  estado() {
    return {
      hayUsbmux: this.hayUsbmux,
      hayCable: Boolean(this.hayCable),
      conectado: this.sesiones.size > 0,
      cuantas: this.sesiones.size,
      principal: this.principal,
      camaras: this.camaras(),
      // Compatibilidad con lo que ya leen el estudio y el puente, que hasta
      // ahora daban por hecho una sola camara.
      origen: this.sesiones.get(this.principal)?.origen || null,
      estadoMovil: this.sesiones.get(this.principal)?.estadoMovil || null,
    };
  }

  #publicar(evento, datos) {
    this.emit('cambio', { evento, datos, estado: this.estado() });
  }

  async detener() {
    clearInterval(this.temporizadorSondeo);
    for (const camara of this.sesiones.values()) camara.sesion.cerrar();
    this.sesiones.clear();
    if (this.servidorWifi) this.servidorWifi.detener();
    if (this.anunciante) this.anunciante.cerrar();
  }
}

module.exports = { Conexion };
