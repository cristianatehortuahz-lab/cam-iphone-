'use strict';

// Mide cuanto tarda el DAW en devolver el micro de la otra interfaz: compara el
// ReaStream que el puente le manda ("nexo-solo") con lo que el DAW saca por su
// Master ("nexo-fl"), que lo lleva mezclado, y busca el desfase que mejor los
// hace coincidir. Es la parte del retraso que pone el ReaStream en modo recibir
// de la pista; antes van la captura de Windows (~10-20 ms) y el colchon del
// puente (15 ms).
//
// Con Nexo y el DAW abiertos, y alguien hablando por ese micro:
//   node herramientas/medir-retraso-micro.js [segundos]

const dgram = require('dgram');

const SEGUNDOS = Number(process.argv[2] || 6);
const PUERTO = 58710;
const CABECERA = 47;
const pistas = { 'nexo-solo': [], 'nexo-fl': [] };
let fs = 44100;

const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
s.on('message', (m) => {
  if (m.length < CABECERA || m.toString('latin1', 0, 4) !== 'MRSR') return;
  const id = m.toString('latin1', 8, 40).replace(/\0+$/, '');
  if (!pistas[id]) return;
  const canales = m.readUInt8(40);
  fs = m.readUInt32LE(41) || fs;
  const porCanal = m.readUInt16LE(45) / 4 / canales;
  if (!canales || !Number.isInteger(porCanal)) return;
  const b = new Float32Array(porCanal);
  for (let i = 0; i < porCanal; i++) b[i] = m.readFloatLE(CABECERA + i * 4);
  pistas[id].push(b);
});

s.bind(PUERTO, () => {
  setTimeout(() => {
    s.close();
    const unir = (t) => { const n = t.reduce((a, x) => a + x.length, 0); const o = new Float32Array(n); let k = 0; for (const x of t) { o.set(x, k); k += x.length; } return o; };
    const a = unir(pistas['nexo-solo']);
    const b = unir(pistas['nexo-fl']);
    if (a.length < fs || b.length < fs) { console.log(JSON.stringify({ error: 'no llegan los dos ReaStream', solo: a.length, daw: b.length })); return; }
    // Los dos van al mismo paso (un paquete por cada paquete del DAW), asi que
    // basta desplazar uno contra otro. Se prueba hasta 300 ms.
    const n = Math.min(a.length, b.length) - Math.round(fs * 0.3);
    let mejor = 0, pico = -Infinity, ea = 0;
    for (let i = 0; i < n; i++) ea += a[i] * a[i];
    for (let d = 0; d < Math.round(fs * 0.3); d++) {
      let c = 0;
      for (let i = 0; i < n; i += 2) c += a[i] * b[i + d];
      if (c > pico) { pico = c; mejor = d; }
    }
    let eb = 0;
    for (let i = 0; i < n; i++) eb += b[i + mejor] * b[i + mejor];
    console.log(JSON.stringify({
      retrasoEnElDawMs: Math.round((mejor / fs) * 1000),
      parecido: Math.round(((pico * 2) / Math.sqrt(ea * eb)) * 100) / 100, // 1 = identicos; por debajo de ~0,3 no es fiable
      nivelMicroDb: Math.round(10 * Math.log10(ea / n) * 10) / 10,
    }));
  }, SEGUNDOS * 1000);
});
