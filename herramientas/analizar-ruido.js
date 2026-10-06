// Graba unos segundos de lo que sale del DAW por ReaStream (lo mismo que va a
// OBS y a TikTok) y dice que clase de ruido lleva: zumbido de red (50/60 Hz y
// armonicos), chasquidos (saltos bruscos entre muestras) o saturacion (muestras
// pegadas al tope). Nacio el 04/10/2026 para una interferencia en la M-Track Solo
// al juntarla con la AIR por ASIO4ALL.
//
// Nexo Desktop tiene que estar abierto (sin su puente no llega nada aqui).
//
//   node herramientas/analizar-ruido.js [segundos] [archivo.wav]

const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEGUNDOS = Number(process.argv[2] || 8);
const WAV = process.argv[3] || path.join(os.tmpdir(), 'nexo-ruido.wav');
const PUERTO = 58710;
const ID = 'nexo-fl';
const CABECERA = 47;

const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const trozos = [];
let fs_ = 44100;

s.on('message', (m) => {
  if (m.length < CABECERA || m.toString('latin1', 0, 4) !== 'MRSR') return;
  if (m.toString('latin1', 8, 40).replace(/\0+$/, '') !== ID) return;
  const canales = m.readUInt8(40);
  fs_ = m.readUInt32LE(41) || fs_;
  const porCanal = m.readUInt16LE(45) / 4 / canales;
  if (!canales || !Number.isInteger(porCanal)) return;
  const b = new Float32Array(porCanal);
  for (let i = 0; i < porCanal; i++) b[i] = m.readFloatLE(CABECERA + i * 4); // canal izquierdo
  trozos.push(b);
});

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k), sn = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

s.bind(PUERTO, () => {
  setTimeout(() => {
    s.close();
    const n = trozos.reduce((a, t) => a + t.length, 0);
    if (!n) { console.log(JSON.stringify({ error: 'no llega audio por ReaStream' })); return; }
    const x = new Float32Array(n);
    let o = 0;
    for (const t of trozos) { x.set(t, o); o += t.length; }

    // WAV mono de 16 bits, para poder oirlo o abrirlo en un editor.
    const pcm = Buffer.alloc(44 + n * 2);
    pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(fs_, 24); pcm.writeUInt32LE(fs_ * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
    fs.writeFileSync(WAV, pcm);

    let suma = 0, pico = 0, tope = 0, dc = 0;
    for (let i = 0; i < n; i++) { suma += x[i] * x[i]; pico = Math.max(pico, Math.abs(x[i])); if (Math.abs(x[i]) > 0.985) tope++; dc += x[i]; }
    const rms = Math.sqrt(suma / n);

    // Chasquidos: salto entre muestras seguidas muy por encima de lo normal.
    let sd = 0;
    for (let i = 1; i < n; i++) sd += Math.abs(x[i] - x[i - 1]);
    const saltoMedio = sd / (n - 1);
    const umbral = Math.max(saltoMedio * 25, 0.02);
    const clics = [];
    for (let i = 1; i < n; i++) {
      if (Math.abs(x[i] - x[i - 1]) > umbral && (!clics.length || i - clics[clics.length - 1] > fs_ * 0.005)) clics.push(i);
    }
    // ¿Son periodicos? (la deriva entre dos interfaces da chasquidos a ritmo fijo)
    const sep = [];
    for (let i = 1; i < clics.length; i++) sep.push((clics[i] - clics[i - 1]) / fs_ * 1000);
    sep.sort((a, b) => a - b);
    const mediana = sep.length ? sep[Math.floor(sep.length / 2)] : null;

    // Espectro: las 8 frecuencias mas fuertes.
    const N = 65536;
    const picos = [];
    if (n >= N) {
      const mag = new Float64Array(N / 2);
      const bloques = Math.floor(n / N);
      for (let b = 0; b < bloques; b++) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = x[b * N + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
        fft(re, im);
        for (let i = 0; i < N / 2; i++) mag[i] += Math.hypot(re[i], im[i]) / (N / 4) / bloques;
      }
      for (let i = 3; i < N / 2 - 3; i++) {
        if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1] && mag[i] > mag[i - 3] * 1.5 && mag[i] > mag[i + 3] * 1.5) picos.push({ hz: Math.round((i * fs_) / N), db: Math.round(db(mag[i]) * 10) / 10 });
      }
      picos.sort((a, b) => b.db - a.db);
    }
    const banda = (f0, f1) => {
      if (n < N) return null;
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = x[i];
      fft(re, im);
      let e = 0;
      for (let i = Math.floor((f0 * N) / fs_); i < Math.floor((f1 * N) / fs_); i++) e += re[i] * re[i] + im[i] * im[i];
      return Math.round(db(Math.sqrt(e * 2) / N) * 10) / 10;
    };

    console.log(JSON.stringify({
      wav: WAV, segundos: Math.round((n / fs_) * 10) / 10, fs: fs_,
      rmsDb: Math.round(db(rms) * 10) / 10, picoDb: Math.round(db(pico) * 10) / 10,
      muestrasAlTope: tope, continuaDc: Math.round((dc / n) * 10000) / 10000,
      chasquidos: clics.length, chasquidosPorSegundo: Math.round((clics.length / (n / fs_)) * 10) / 10, separacionMedianaMs: mediana && Math.round(mediana * 10) / 10,
      bandasDb: { 'graves <200': banda(20, 200), '200-2k': banda(200, 2000), '2k-8k': banda(2000, 8000), '8k-20k': banda(8000, 20000) },
      frecuenciasFuertes: picos.slice(0, 10),
    }, null, 1));
  }, SEGUNDOS * 1000);
});
