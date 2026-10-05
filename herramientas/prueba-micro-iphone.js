'use strict';

// Prueba del micro del iPhone hacia el directo, sin iPhone ni DAW:
//   - micro-iphone.js decodifica un tono AAC como el que manda Nexo Cam;
//   - puente-audio.js lo mezcla en paquetes ReaStream de un DAW simulado, o los
//     fabrica el mismo si no hay DAW;
//   - un oyente (como el ReaStream de OBS) mide lo que sale.
//
//   node herramientas/prueba-micro-iphone.js
//
// Usa un puerto propio: se puede lanzar con Nexo y el DAW abiertos.

const dgram = require('dgram');
const { spawnSync } = require('child_process');
const { PuenteAudio } = require('../nexo-desktop/src/main/puente-audio');
const { MicroIphone } = require('../nexo-desktop/src/main/micro-iphone');

const PUERTO = 58999;
const CABECERA = 47;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
function comprobar(nombre, bien, detalle = '') {
  if (!bien) fallos++;
  console.log(`${bien ? ' OK ' : 'FALLA'}  ${nombre}${detalle ? '  (' + detalle + ')' : ''}`);
}
const db = (x) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -Infinity);

// Tono de 440 Hz a media escala, mono, en AAC con cabeceras ADTS.
function fabricarTono(segundos) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${segundos}`,
    '-af', 'volume=4', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', 'pipe:1',
  ], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('ffmpeg no pudo fabricar el tono: ' + r.stderr);
  const paquetes = [];
  for (let i = 0; i + 7 <= r.stdout.length;) {
    const largo = ((r.stdout[i + 3] & 3) << 11) | (r.stdout[i + 4] << 3) | (r.stdout[i + 5] >> 5);
    if (r.stdout[i] !== 0xff || largo < 7) break;
    paquetes.push(r.stdout.subarray(i, i + largo));
    i += largo;
  }
  return paquetes;
}

// Lo que oye quien escucha el puerto, como el ReaStream de OBS.
class Oyente {
  constructor() {
    this.s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.reiniciar();
    this.s.on('message', (m) => {
      if (m.length < CABECERA || m.toString('latin1', 0, 4) !== 'MRSR') return;
      const canales = m.readUInt8(40);
      const porCanal = m.readUInt16LE(45) / 4 / canales;
      this.paquetes++;
      this.tamanoOk = this.tamanoOk && m.readUInt32LE(4) === m.length;
      for (let i = 0; i < porCanal; i++) {
        const l = m.readFloatLE(CABECERA + i * 4);
        const r = m.readFloatLE(CABECERA + (porCanal + i) * 4);
        this.sumaL += l * l;
        this.sumaR += r * r;
        // Un corte se ve como un salto brusco en una senal que es un tono suave.
        // (un tono de 440 Hz a media escala cambia como mucho 0,03 entre muestras).
        if (this.antes !== null && Math.abs(r - this.antes) > 0.08) this.saltos++;
        this.antes = r;
      }
      this.muestras += porCanal;
    });
  }
  abrir() { return new Promise((ok) => this.s.bind(PUERTO, '0.0.0.0', ok)); }
  reiniciar() {
    this.paquetes = 0; this.muestras = 0; this.sumaL = 0; this.sumaR = 0;
    this.saltos = 0; this.antes = null; this.tamanoOk = true; this.desde = Date.now();
  }
  medida() {
    const seg = (Date.now() - this.desde) / 1000;
    return {
      porSegundo: Math.round(this.muestras / seg),
      l: db(Math.sqrt(this.sumaL / (this.muestras || 1))),
      r: db(Math.sqrt(this.sumaR / (this.muestras || 1))),
      saltos: this.saltos,
      tamanoOk: this.tamanoOk,
    };
  }
}

// Un DAW que manda por ReaStream un tono de 1 kHz solo por la izquierda.
function dawSimulado() {
  const s = dgram.createSocket('udp4');
  const BLOQUE = 144;
  let enviadas = 0;
  const inicio = process.hrtime.bigint();
  const reloj = setInterval(() => {
    const debidas = Number(((process.hrtime.bigint() - inicio) * 44100n) / 1000000000n);
    while (debidas - enviadas >= BLOQUE) {
      const p = Buffer.alloc(CABECERA + BLOQUE * 8);
      p.write('MRSR', 0, 'latin1');
      p.writeUInt32LE(p.length, 4);
      p.write('nexo-fl', 8, 'latin1');
      p.writeUInt8(2, 40);
      p.writeUInt32LE(44100, 41);
      p.writeUInt16LE(BLOQUE * 8, 45);
      for (let i = 0; i < BLOQUE; i++) {
        p.writeFloatLE(0.25 * Math.sin((2 * Math.PI * 1000 * (enviadas + i)) / 44100), CABECERA + i * 4);
      }
      s.send(p, PUERTO, '127.0.0.1');
      enviadas += BLOQUE;
    }
  }, 2);
  return () => { clearInterval(reloj); s.close(); };
}

(async () => {
  const tono = fabricarTono(16);
  comprobar('tono de ensayo en AAC', tono.length > 600, `${tono.length} paquetes`);

  const oyente = new Oyente();
  await oyente.abrir();
  const puente = new PuenteAudio({ puerto: PUERTO });
  await puente.iniciar();

  const lineas = [];
  const micro = new MicroIphone({ registro: { log: (...a) => lineas.push(a.join(' ')), error: (...a) => lineas.push('ERROR ' + a.join(' ')) } });
  let decodificadas = 0;
  const tiempos = []; // [hora, muestras acumuladas]
  micro.on('pcm', (pcm) => {
    decodificadas += pcm.length;
    tiempos.push([Date.now(), decodificadas]);
    puente.microPcm(pcm);
  });

  // El iPhone manda siempre; lo que cambia es el interruptor.
  let k = 0;
  const enviados = [];
  const inicio = Date.now();
  const iphone = setInterval(() => {
    while (k < tono.length && inicio + (k * 1024000) / 44100 <= Date.now()) {
      enviados[k] = Date.now();
      micro.escribir({ datos: tono[k] });
      k++;
    }
  }, 2);

  // --- 1. Apagado: no sale nada ---
  await espera(1500);
  comprobar('con el interruptor apagado no sale nada', oyente.paquetes === 0 && decodificadas === 0);

  // --- 2. Encendido y sin DAW: el puente fabrica los paquetes ---
  const primero = k; // primer paquete que ve el decodificador
  micro.activar(true);
  puente.micro(true, 1);
  await espera(1500); // arranque de ffmpeg y llenado del colchon
  oyente.reiniciar();
  await espera(3000);
  let m = oyente.medida();
  comprobar('sin DAW, sale el micro solo', Math.abs(m.porSegundo - 44100) < 900 && Math.abs(m.r - -9) < 1.5 && Math.abs(m.l - m.r) < 0.2,
    `${m.porSegundo} muestras/s, L ${m.l} dB, R ${m.r} dB`);
  comprobar('sin cortes', m.saltos === 0, `${m.saltos} saltos`);
  comprobar('paquetes con el tamano bien declarado', m.tamanoOk);

  // Retraso del decodificador: cuando entrega el audio del paquete i frente a
  // cuando se le dio.
  const retrasos = [];
  for (let i = primero + 40; i < k; i++) {
    const t = tiempos.find((x) => x[1] >= (i - primero + 1) * 1024);
    if (t) retrasos.push(t[0] - enviados[i]);
  }
  retrasos.sort((x, y) => x - y);
  comprobar('el decodificador va al dia', retrasos.length > 50 && retrasos[retrasos.length >> 1] < 60,
    'mediana ' + retrasos[retrasos.length >> 1] + ' ms, peor ' + retrasos[retrasos.length - 1] + ' ms');

  // --- 3. Con DAW: se mezcla en sus paquetes ---
  const pararDaw = dawSimulado();
  await espera(1200);
  oyente.reiniciar();
  await espera(3000);
  m = oyente.medida();
  // Izquierda: 1 kHz a -15 dB mas el micro a -9 dB = -8 dB. Derecha: solo el micro.
  comprobar('con DAW, el micro se suma a su audio', Math.abs(m.porSegundo - 44100) < 900 && Math.abs(m.r - -9) < 1.5 && Math.abs(m.l - -8) < 1.5,
    `${m.porSegundo} muestras/s, L ${m.l} dB, R ${m.r} dB`);
  comprobar('sin cortes en la mezcla', m.saltos === 0, `${m.saltos} saltos`);

  // --- 4. Volumen ---
  puente.micro(true, 0.5);
  await espera(300);
  oyente.reiniciar();
  await espera(1500);
  m = oyente.medida();
  comprobar('al 50 % baja 6 dB', Math.abs(m.r - -15) < 1.5, `R ${m.r} dB`);

  // --- 5. Apagar con el DAW sonando: el audio del DAW queda intacto ---
  micro.activar(false);
  puente.micro(false);
  await espera(300);
  oyente.reiniciar();
  await espera(1500);
  m = oyente.medida();
  comprobar('apagado, el DAW pasa intacto', m.r === -Infinity && Math.abs(m.l - -15) < 0.5, `L ${m.l} dB, R ${m.r} dB`);

  pararDaw();
  clearInterval(iphone);
  micro.detener();
  puente.detener();
  oyente.s.close();

  const errores = lineas.filter((l) => l.startsWith('ERROR'));
  comprobar('sin errores en el registro', errores.length === 0, errores.slice(0, 2).join(' | '));
  console.log(fallos ? `\n${fallos} comprobacion(es) fallaron` : '\nTodo bien');
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
