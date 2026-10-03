// Comprueba el audio que sale de FL Studio por ReaStream (el que reenvia el
// puente de Nexo). Lo usa iniciar-directo.ps1.
//
// Escucha unos segundos y detecta los dos fallos que ya han pasado:
//   - silencio digital exacto: FL en el driver de prueba de ASIO Link Pro, o la
//     entrada del Master con el monitoreo en "Cuando este armada";
//   - un canal mucho mas fuerte que el otro: la entrada en estereo "In 1 - In 2"
//     con el micro solo en In 1.
//
// Imprime una linea JSON. Nexo Desktop tiene que estar abierto (sin su puente
// no llega nada aqui).
//
//   node herramientas/comprobar-audio.js [segundos]

const dgram = require('dgram');

const SEGUNDOS = Number(process.argv[2] || 4);
const PUERTO = 58710;
const ID = 'nexo-fl';
const CABECERA = 47;

const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let paquetes = 0;
let muestras = 0; // por canal: lo que importa (FL y Reaper parten el audio en paquetes de distinto tamano)
let segundosSilencio = 0;
let silencioEsteSegundo = true;
let sumaL = 0, sumaR = 0, cuenta = 0;

s.on('message', (m) => {
  if (m.length < CABECERA || m.toString('latin1', 0, 4) !== 'MRSR') return;
  if (m.toString('latin1', 8, 40).replace(/\0+$/, '') !== ID) return;
  paquetes++;
  const canales = m.readUInt8(40);
  const bytes = m.readUInt16LE(45);
  const porCanal = bytes / 4 / canales;
  if (!canales || !Number.isInteger(porCanal)) return;
  muestras += porCanal;
  // Canales seguidos: todo el izquierdo y luego todo el derecho.
  for (let i = 0; i < porCanal; i++) {
    const l = m.readFloatLE(CABECERA + i * 4);
    const r = canales > 1 ? m.readFloatLE(CABECERA + (porCanal + i) * 4) : l;
    sumaL += l * l;
    sumaR += r * r;
    if (l !== 0 || r !== 0) silencioEsteSegundo = false;
  }
  cuenta += porCanal;
});

const db = (suma) => (cuenta && suma > 0 ? 10 * Math.log10(suma / cuenta) : -Infinity);

s.on('error', (e) => {
  process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  process.exit(0);
});

s.bind(PUERTO, '0.0.0.0', () => {
  let t = 0;
  const reloj = setInterval(() => {
    t++;
    if (silencioEsteSegundo) segundosSilencio++;
    silencioEsteSegundo = true;
    if (t < SEGUNDOS) return;
    clearInterval(reloj);
    s.close();
    const l = db(sumaL);
    const r = db(sumaR);
    const redondea = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
    process.stdout.write(
      JSON.stringify({
        segundos: SEGUNDOS,
        paquetesPorSegundo: Math.round(paquetes / SEGUNDOS),
        muestrasPorSegundo: Math.round(muestras / SEGUNDOS), // ~44100 si no se pierde nada
        segundosSilencio,
        nivelL: redondea(l),
        nivelR: redondea(r),
        desequilibrioDb:
          Number.isFinite(l) && Number.isFinite(r) ? Math.round(Math.abs(l - r) * 10) / 10 : null,
      }) + '\n'
    );
  }, 1000);
});
