'use strict';

// Decodificador de video de Nexo, para el proceso de interfaz (renderer). Toma
// las unidades NAL H.264 (Annex-B) que llegan del iPhone y las convierte en
// VideoFrame con WebCodecs, la API de decodificacion por hardware que Chromium
// —y por tanto Electron— trae de serie. Cada VideoFrame entra despues como
// textura en el motor de color (procesador.js), sin pasar por un <video>.
//
// Annex-B: las NAL van separadas por el codigo de inicio 00 00 01 / 00 00 00 01.
// El decodificador de WebCodecs en modo 'annexb' las acepta tal cual.

class DecodificadorVideo {
  constructor({ onFrame, onError } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onError = onError || ((e) => console.error('decodificador:', e));
    this.decoder = null;
    this.configurado = false;
    this.esperandoClave = true; // hasta el primer fotograma clave no hay nada que decodificar
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

  #crear() {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          this.onFrame(frame);
        } finally {
          frame.close(); // liberar cuanto antes: los VideoFrame consumen memoria de GPU
        }
      },
      error: (e) => this.onError(e),
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
      hardwareAcceleration: 'prefer-hardware',
      ...(ancho && alto ? { codedWidth: ancho, codedHeight: alto } : {}),
    });
    this.configurado = true;
  }

  // Alimenta una NAL (o grupo de NAL de un fotograma). microsegundos = marca de
  // tiempo que venia en la trama Nexo.
  decodificar(datos, microsegundos, esClave) {
    if (!this.configurado) this.configurar();
    // El decodificador necesita empezar por un fotograma clave; los delta que
    // lleguen antes se descartan para no arrancar con basura.
    if (this.esperandoClave) {
      if (!esClave) return;
      this.esperandoClave = false;
    }
    const chunk = new EncodedVideoChunk({
      type: esClave ? 'key' : 'delta',
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
  static esFotogramaClave(datos) {
    for (let i = 0; i + 3 < datos.length && i < 64; i++) {
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
