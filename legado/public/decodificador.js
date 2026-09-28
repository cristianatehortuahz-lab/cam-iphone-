'use strict';

// Decodificador de video de Nexo, para el proceso de interfaz (renderer). Toma
// las unidades NAL H.264 (Annex-B) que llegan del iPhone y las convierte en
// VideoFrame con WebCodecs, la API de decodificacion por hardware que Chromium
// —y por tanto Electron— trae de serie. Cada VideoFrame entra despues como
// textura en el motor de color (procesador.js), sin pasar por un <video>.
//
// Annex-B: las NAL van separadas por el codigo de inicio 00 00 01 / 00 00 00 01.
// El decodificador de WebCodecs en modo 'annexb' las acepta tal cual.

// Fotogramas encolados en el decodificador a partir de los cuales se considera
// que no da abasto de forma sostenida (30 = un segundo a 30 fps).
//
// Antes eran 6, y eso fabricaba congelaciones: cada fotograma clave atasca el
// decodificador unos 190 ms (medido en la fuente de OBS el 28/09/2026), lo que
// acumula ~6 fotogramas en cola. Con el umbral en 6, la valvula saltaba en cada
// clave y tiraba todo hasta la siguiente, que volvia a atascar: congelaciones
// de hasta 1 s que se realimentaban, "como a proposito". El atasco normal de una
// clave tiene que caber holgado por debajo del umbral.
const COLA_MAXIMA = 30;

// Por encima de esto se decodifica por hardware; por debajo, por software.
// Medido en la fuente de OBS el 28/09/2026, con un Ryzen 5 7520U:
//   hardware  cada fotograma clave atasca ~190 ms, fijo, sea cual sea la
//             resolucion (igual a 480p que a 1080p): un tiron visible cada 2 s
//   software  sin ese atasco (~75 ms de hueco maximo a 720p), pero a 1080p el
//             procesador no da abasto y pinta menos de la mitad
// 720p (921 600 pixeles) es lo mas grande que el software aguanta con holgura.
const MAX_PIXELES_SOFTWARE = 1000000;

class DecodificadorVideo {
  constructor({ onFrame, onError } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onError = onError || ((e) => console.error('decodificador:', e));
    this.decoder = null;
    this.configurado = false;
    this.esperandoClave = true; // hasta el primer fotograma clave no hay nada que decodificar
    // Se arranca por hardware, que aguanta cualquier tamano sin ahogar la CPU.
    // El primer fotograma dice si conviene software (ver MAX_PIXELES_SOFTWARE),
    // y el cambio se hace en la siguiente clave.
    this.porHardware = true;
    this.modoDeseado = true;
    this.cambioPendiente = false;
  }

  static soportado() {
    return typeof globalThis.VideoDecoder === 'function';
  }

  // Comprueba que el equipo puede decodificar H.264 antes de intentarlo.
  static async comprobarH264() {
    if (!DecodificadorVideo.soportado()) return { soportado: false, motivo: 'WebCodecs no disponible' };
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.640034', optimizeForLatency: true });
      return { soportado: Boolean(r.supported), config: r.config || null };
    } catch (e) {
      return { soportado: false, motivo: e.message };
    }
  }

  // El VideoFrame se ENTREGA a onFrame, que pasa a ser su dueño y debe cerrarlo
  // cuando termine (son memoria de GPU: no se pueden dejar sueltos).
  //
  // Antes se cerraba aqui mismo, en un `finally`, nada mas volver de onFrame. El
  // consumidor —el procesador de color, que lo guarda para dibujarlo en el
  // siguiente fotograma— se quedaba con un frame ya cerrado: displayWidth 0,
  // lienzo de 0x0 y pantalla en negro con el video llegando entero.
  #crear() {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        // El tamano se lee antes de entregarlo: el consumidor lo cierra, y un
        // VideoFrame cerrado mide 0x0.
        const quiereHardware = frame.displayWidth * frame.displayHeight > MAX_PIXELES_SOFTWARE;
        if (quiereHardware !== this.porHardware) {
          this.modoDeseado = quiereHardware;
          this.cambioPendiente = true;
        }
        try {
          this.onFrame(frame);
        } catch (e) {
          frame.close(); // si el consumidor falla, nadie mas lo va a liberar
          this.onError(e);
        }
      },
      error: (e) => {
        // Un error deja el codec CERRADO: WebCodecs no admite mas decode() en
        // el. Antes solo se volvia a exigir clave, y el estudio —cuyo onError
        // solo anota el fallo— se quedaba con un decodificador muerto para
        // siempre. cerrar() lo suelta: el siguiente fotograma lo recrea, y
        // exige clave con su configuracion completa.
        this.cerrar();
        this.onError(e);
      },
    });
  }

  configurar({ ancho, alto } = {}) {
    if (!this.decoder) this.#crear();
    // 'annexb' hace que el decodificador acepte las NAL con codigos de inicio,
    // que es justo como las emite VideoToolbox en el iPhone. optimizeForLatency
    // reduce el buffer interno: importa para un directo.
    this.decoder.configure({
      codec: 'avc1.640034',
      optimizeForLatency: true,
      hardwareAcceleration: this.porHardware ? 'prefer-hardware' : 'prefer-software',
      ...(ancho && alto ? { codedWidth: ancho, codedHeight: alto } : {}),
    });
    this.configurado = true;
  }

  // Alimenta una NAL (o grupo de NAL de un fotograma). microsegundos = marca de
  // tiempo que venia en la trama Nexo.
  decodificar(datos, microsegundos, esClave) {
    // No nos fiamos solo del flag del emisor. Nexo Cam marca como delta hasta
    // los fotogramas que llevan una IDR de verdad (el bit se pierde en el
    // camino), y creerselo dejaba el estudio en negro para siempre: sin una
    // clave, la condicion de abajo descarta absolutamente todo. El bitstream no
    // miente, asi que se confirma mirando las NAL.
    const clave = esClave || DecodificadorVideo.esFotogramaClave(datos);

    // Cambio entre hardware y software pendiente: se hace justo en una clave,
    // para que el decodificador nuevo arranque limpio en ella sin perder imagen.
    if (clave && this.cambioPendiente) {
      this.cambioPendiente = false;
      this.porHardware = this.modoDeseado;
      this.cerrar();
    }
    if (!this.configurado) this.configurar();

    // El decodificador necesita empezar por un fotograma clave; los delta que
    // lleguen antes se descartan para no arrancar con basura.
    if (this.esperandoClave) {
      if (!clave) return;
      this.esperandoClave = false;
    }

    // Valvula de seguridad: WebCodecs no descarta nada por su cuenta, asi que
    // si el decodificador va por detras la cola crece sin limite y con ella la
    // latencia, hasta ahogarse. Cuando se acumula mucho, dejamos de alimentar
    // deltas y esperamos a la siguiente clave: se pierde hasta el proximo IDR,
    // pero se vuelve a directo en vez de quedarse cada vez mas atras.
    if (!clave && this.decoder && this.decoder.decodeQueueSize > COLA_MAXIMA) {
      this.esperandoClave = true;
      return;
    }
    const chunk = new EncodedVideoChunk({
      type: clave ? 'key' : 'delta',
      timestamp: microsegundos,
      data: datos,
    });
    try {
      this.decoder.decode(chunk);
    } catch (e) {
      this.onError(e);
    }
  }

  // Detecta si una NAL Annex-B contiene un fotograma clave (IDR, tipo NAL 5).
  // Se salta el codigo de inicio y mira los 5 bits bajos del primer byte NAL.
  //
  // Sin limite de ventana: el bucle ya sale en la primera NAL que decide
  // (IDR/SPS/PPS -> clave, slice no-IDR -> delta), asi que el coste real es de
  // unos pocos bytes. Con el tope de 64 que habia antes, un fotograma cuyo SEI
  // fuera largo se clasificaba mal por no llegar a mirar la NAL que importa.
  static esFotogramaClave(datos) {
    for (let i = 0; i + 3 < datos.length; i++) {
      const codigo3 = datos[i] === 0 && datos[i + 1] === 0 && datos[i + 2] === 1;
      const codigo4 = datos[i] === 0 && datos[i + 1] === 0 && datos[i + 2] === 0 && datos[i + 3] === 1;
      if (codigo3 || codigo4) {
        const tipoNal = datos[i + (codigo4 ? 4 : 3)] & 0x1f;
        if (tipoNal === 5) return true; // IDR
        if (tipoNal === 7 || tipoNal === 8) return true; // SPS/PPS acompanan a la clave
        if (tipoNal === 1) return false; // slice no-IDR (delta)
      }
    }
    return false;
  }

  async vaciar() {
    if (this.decoder && this.decoder.state === 'configured') {
      try {
        await this.decoder.flush();
      } catch {
        /* al cerrar puede rechazar: da igual */
      }
    }
  }

  cerrar() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.configurado = false;
    this.esperandoClave = true;
  }
}

if (typeof module !== 'undefined') module.exports = { DecodificadorVideo };
if (typeof window !== 'undefined') window.DecodificadorVideo = DecodificadorVideo;
