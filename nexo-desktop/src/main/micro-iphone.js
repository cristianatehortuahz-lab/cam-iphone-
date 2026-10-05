'use strict';

// El micro del iPhone, para el directo.
//
// Nexo Cam ya manda el sonido de su microfono junto al video (AAC en ADTS, cada
// paquete con su cabecera), pero hasta ahora solo lo oia el estudio. Aqui se
// decodifica a audio en crudo para que el puente (puente-audio.js) lo mezcle en
// el audio que ya sale hacia OBS y hacia TikTok. Sirve para que se oiga a quien
// este al lado del iPhone ayudando a producir.
//
// Va apagado por defecto: ese micro tambien recoge la voz de quien canta, sin
// Auto-Tune, y lo que suene por los altavoces, con retraso. Con el interruptor
// apagado no hay ningun proceso gastando CPU.
//
// Decodifica ffmpeg y no el navegador del estudio porque tiene que funcionar con
// la ventana en la bandeja, que es como va Nexo durante un directo.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buscarFfmpeg } = require('./grabador');

const FRECUENCIA = 44100; // la del directo; ffmpeg convierte si el iPhone manda otra

class MicroIphone extends EventEmitter {
  constructor({ registro = console } = {}) {
    super();
    this.registro = registro;
    this.activo = false;
    this.proceso = null;
    this.resto = null;      // bytes sueltos de una muestra partida entre dos trozos
    this.reintento = 0;     // hora hasta la que no se vuelve a lanzar ffmpeg
    this.ultimo = 0;        // cuando salio audio decodificado por ultima vez
    this.pico = 0;          // nivel maximo desde el ultimo informe
    this.motivo = null;
  }

  estado() {
    return {
      activo: this.activo,
      llega: this.activo && Date.now() - this.ultimo < 1000,
      motivo: this.motivo,
    };
  }

  activar(activo) {
    activo = Boolean(activo);
    if (activo === this.activo) return;
    this.activo = activo;
    this.motivo = null;
    this.reintento = 0;
    if (!activo) this.#parar();
  }

  // Cada paquete de audio de la camara principal: { datos }.
  escribir(a) {
    if (!this.activo) return;
    if (!this.proceso) {
      if (Date.now() < this.reintento) return;
      this.#arrancar();
      if (!this.proceso) return;
    }
    this.proceso.stdin.write(a.datos);
  }

  // La sesion con el iPhone se cerro: el siguiente audio empieza de cero.
  cortar() {
    this.#parar();
  }

  detener() {
    this.activo = false;
    this.#parar();
  }

  #parar() {
    const p = this.proceso;
    this.proceso = null;
    this.resto = null;
    if (!p) return;
    p.removeAllListeners('exit');
    try { p.kill(); } catch { /* ya habia terminado */ }
    try { p.stdin.destroy(); } catch { /* ya estaba cerrado */ }
  }

  #arrancar() {
    const ffmpeg = buscarFfmpeg();
    if (!ffmpeg) {
      this.motivo = 'falta ffmpeg';
      this.reintento = Date.now() + 30000;
      this.registro.error('[micro] falta ffmpeg: el micro del iPhone no puede salir al directo');
      return;
    }
    const p = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      // Mismas opciones de arranque que la camara (ver camara-virtual.js).
      '-probesize', '32', '-analyzeduration', '1',
      '-f', 'aac', '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', String(FRECUENCIA),
      // Cada paquete decodificado sale al momento, sin esperar a llenar un bufer.
      '-f', 'f32le', '-flush_packets', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proceso = p;
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) this.registro.error('[micro] ffmpeg:', t.split('\n')[0]);
    });
    p.stdout.on('data', (trozo) => this.#audio(trozo));
    const caido = (porque) => {
      if (this.proceso !== p) return;
      this.proceso = null;
      this.resto = null;
      this.reintento = Date.now() + 2000;
      this.registro.error('[micro] el decodificador se paro:', porque);
    };
    p.on('error', (e) => caido(e.message));
    p.on('exit', (codigo) => caido('codigo ' + codigo));
    this.registro.log('[micro] micro del iPhone al directo');
  }

  // Bytes de ffmpeg (floats de 32 bits, mono) -> evento 'pcm' con Float32Array.
  #audio(trozo) {
    if (this.resto) trozo = Buffer.concat([this.resto, trozo]);
    const sobra = trozo.length % 4;
    this.resto = sobra ? Buffer.from(trozo.subarray(trozo.length - sobra)) : null;
    const n = (trozo.length - sobra) / 4;
    if (!n) return;
    // Copia a memoria propia y alineada: el trozo es una vista de un bufer mayor.
    const pcm = new Float32Array(n);
    Buffer.from(pcm.buffer).set(trozo.subarray(0, n * 4));
    for (let i = 0; i < n; i++) {
      const v = Math.abs(pcm[i]);
      if (v > this.pico) this.pico = v;
    }
    this.ultimo = Date.now();
    this.emit('pcm', pcm);
  }

  // Nivel maximo (0..1) desde la ultima llamada. Para el registro.
  leerPico() {
    const p = this.pico;
    this.pico = 0;
    return p;
  }
}

module.exports = { MicroIphone, FRECUENCIA };
