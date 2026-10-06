'use strict';

// Prueba del micro de otra interfaz hacia el DAW, sin interfaz ni DAW:
//   - un DAW simulado manda paquetes ReaStream "nexo-fl" a su ritmo;
//   - se le da al puente un tono como el que entrega micro-windows.js, a OTRA
//     frecuencia de muestreo y con el reloj un poco desviado, que es el caso real
//     de dos interfaces;
//   - un oyente (como el ReaStream en modo recibir de la pista) mide lo que sale
//     con el identificador "nexo-solo".
//
//   node herramientas/prueba-micro-windows.js
//
// Usa un puerto propio: se puede lanzar con Nexo y el DAW abiertos.

const dgram = require('dgram');
const { PuenteAudio } = require('../nexo-desktop/src/main/puente-audio');

const PUERTO = 58998;
const CABECERA = 47;
const ID = 'nexo-solo';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
function comprobar(nombre, bien, detalle = '') {
  if (!bien) fallos++;
  console.log(`${bien ? ' OK ' : 'FALLA'}  ${nombre}${detalle ? '  (' + detalle + ')' : ''}`);
}
const db = (x) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -Infinity);

// Lo que recibe la pista del DAW.
class Oyente {
  constructor() {
    this.s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.reiniciar();
    this.s.on('message', (m) => {
      if (m.length < CABECERA || m.toString('latin1', 0, 4) !== 'MRSR') return;
      if (m.toString('latin1', 8, 40).replace(/\0+$/, '') !== ID) return;
      const canales = m.readUInt8(40);
      const porCanal = m.readUInt16LE(45) / 4 / canales;
      this.paquetes++;
      this.canales = canales;
      this.fs = m.readUInt32LE(41);
      this.tamanoOk = this.tamanoOk && m.readUInt32LE(4) === m.length;
      for (let i = 0; i < porCanal; i++) {
        const v = m.readFloatLE(CABECERA + i * 4);
        this.suma += v * v;
        // Un tono de 440 Hz a media escala cambia como mucho 0,03 entre muestras.
        if (this.antes !== null && Math.abs(v - this.antes) > 0.08) this.saltos++;
        if (this.antes !== null && this.antes < 0 && v >= 0) this.cruces++;
        this.antes = v;
      }
      this.muestras += porCanal;
    });
  }
  abrir() { return new Promise((ok) => this.s.bind(PUERTO, '0.0.0.0', ok)); }
  reiniciar() {
    this.paquetes = 0; this.muestras = 0; this.suma = 0; this.saltos = 0; this.cruces = 0;
    this.antes = null; this.tamanoOk = true; this.canales = 0; this.fs = 0; this.desde = Date.now();
  }
  medida() {
    const seg = (Date.now() - this.desde) / 1000;
    return {
      muestrasPorSegundo: Math.round(this.muestras / seg),
      nivel: db(Math.sqrt(this.suma / Math.max(1, this.muestras))),
      hz: this.muestras ? Math.round((this.cruces / this.muestras) * this.fs) : 0,
      saltos: this.saltos, paquetes: this.paquetes,
    };
  }
}

// El DAW: paquetes "nexo-fl" de 2 canales, 44 100 Hz y 144 muestras, en silencio.
function dawSimulado() {
  const s = dgram.createSocket('udp4');
  const BLOQUE = 144;
  const p = Buffer.alloc(CABECERA + BLOQUE * 2 * 4);
  p.write('MRSR', 0, 'latin1'); p.writeUInt32LE(p.length, 4); p.write('nexo-fl', 8, 'latin1');
  p.writeUInt8(2, 40); p.writeUInt32LE(44100, 41); p.writeUInt16LE(BLOQUE * 2 * 4, 45);
  const t0 = process.hrtime.bigint();
  let mandadas = 0;
  const reloj = setInterval(() => {
    const debidas = Number(((process.hrtime.bigint() - t0) * 44100n) / 1000000000n);
    while (debidas - mandadas >= BLOQUE) { s.send(p, PUERTO, '127.0.0.1'); mandadas += BLOQUE; }
  }, 2);
  return () => { clearInterval(reloj); s.close(); };
}

// El micro: tono de 440 Hz a media escala en trozos de 10 ms, a `fs` nominales
// pero con el reloj corriendo `ppm` partes por millon mas deprisa.
function microSimulado(puente, fs, ppm) {
  const real = fs * (1 + ppm / 1e6);
  const t0 = process.hrtime.bigint();
  let hechas = 0;
  const reloj = setInterval(() => {
    const debidas = Math.floor((Number(process.hrtime.bigint() - t0) / 1e9) * real);
    const trozo = Math.round(fs / 100);
    while (debidas - hechas >= trozo) {
      const pcm = new Float32Array(trozo);
      for (let i = 0; i < trozo; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (hechas + i)) / fs);
      puente.extraPcm(fs, pcm);
      hechas += trozo;
    }
  }, 3);
  return () => clearInterval(reloj);
}

(async () => {
  const puente = new PuenteAudio({ puerto: PUERTO });
  await puente.iniciar();
  const oyente = new Oyente();
  await oyente.abrir();
  const pararDaw = dawSimulado();

  // Apagado: no sale nada.
  let pararMicro = microSimulado(puente, 48000, 0);
  await espera(1500);
  comprobar('con el interruptor apagado no sale nada', oyente.medida().paquetes === 0);
  pararMicro();

  // Caso real: micro a 48 000 Hz con el reloj 300 ppm deprisa, DAW a 44 100.
  puente.extra(true, ID);
  pararMicro = microSimulado(puente, 48000, 300);
  await espera(1500); // el colchon se llena
  oyente.reiniciar();
  await espera(8000);
  let m = oyente.medida();
  comprobar('sale al ritmo del DAW, no al del micro', Math.abs(m.muestrasPorSegundo - 44100) < 400, `${m.muestrasPorSegundo} muestras/s`);
  comprobar('dos canales (centrado), a la frecuencia del DAW', oyente.canales === 2 && oyente.fs === 44100, `${oyente.canales} canal(es), ${oyente.fs} Hz`);
  comprobar('el tono llega afinado', Math.abs(m.hz - 440) <= 3, `${m.hz} Hz`);
  comprobar('con su nivel', Math.abs(m.nivel - (-9)) < 1, `${m.nivel} dB`);
  comprobar('sin cortes con el reloj desviado 300 ppm', m.saltos === 0, `${m.saltos} saltos`);
  comprobar('paquetes con el tamano bien declarado', oyente.tamanoOk);
  pararMicro();

  // El otro lado: micro a 44 100 Hz y 300 ppm despacio.
  await espera(800);
  pararMicro = microSimulado(puente, 44100, -300);
  await espera(1500);
  oyente.reiniciar();
  await espera(6000);
  m = oyente.medida();
  comprobar('a 44 100 Hz y 300 ppm despacio, sin cortes', m.saltos === 0 && Math.abs(m.hz - 440) <= 3, `${m.saltos} saltos, ${m.hz} Hz`);

  // Si el micro se calla (interfaz desenchufada), deja de salir.
  pararMicro();
  await espera(1200);
  oyente.reiniciar();
  await espera(1000);
  comprobar('sin micro, deja de mandar', oyente.medida().paquetes === 0);

  pararDaw();
  puente.detener();
  oyente.s.close();
  console.log(fallos ? `\n${fallos} comprobacion(es) fallan` : '\nTodo bien');
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
