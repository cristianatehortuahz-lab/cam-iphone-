'use strict';

// Prueba de las dos camaras en una (nexo-desktop/src/main/camara-virtual.js,
// planificarDos) sin moviles: fabrica dos videos H.264 de color liso, uno rojo
// a 30 fps y otro azul a 60 (cada movil va a su ritmo), se los da a la camara
// como principal y segunda y comprueba lo que sale por "OBS Virtual Camera".
//
//   node herramientas/prueba-dos-camaras.js
//
// Necesita ffmpeg y OBS instalado. Con Nexo Desktop abierto y su camara activa
// da "ocupada": cierralo antes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { CamaraVirtual, extraerSps, planificarDos } = require('../nexo-desktop/src/main/camara-virtual');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-prueba-dos-'));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
function comprobar(nombre, bien, detalle = '') {
  if (!bien) fallos++;
  console.log(`${bien ? ' OK ' : 'FALLA'}  ${nombre}${detalle ? '  (' + detalle + ')' : ''}`);
}

function fabricar(color, ancho, alto, fps, segundos) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=${ancho}x${alto}:rate=${fps}`,
    '-t', String(segundos), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(fps * 2),
    '-x264-params', 'aud=1:repeat-headers=1', '-f', 'h264', 'pipe:1',
  ], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg no pudo fabricar el video: ' + r.stderr);
  const flujo = r.stdout;
  const cortes = [];
  for (let i = 0; i + 5 < flujo.length; i++) {
    if (flujo[i] === 0 && flujo[i + 1] === 0 && flujo[i + 2] === 0 && flujo[i + 3] === 1 && (flujo[i + 4] & 0x1f) === 9) cortes.push(i);
  }
  return cortes.map((c, k) => {
    const datos = flujo.subarray(c + 6, cortes[k + 1] ?? flujo.length);
    return { datos, clave: Boolean(extraerSps(datos)) };
  });
}

function leerCamara(ancho, alto) {
  return new Promise((resolver) => {
    const p = spawn('ffmpeg', [
      '-v', 'error', '-f', 'dshow', '-video_size', `${ancho}x${alto}`, '-i', 'video=OBS Virtual Camera',
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'nv12', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const trozos = [];
    p.stdout.on('data', (d) => trozos.push(d));
    const plazo = setTimeout(() => p.kill(), 15000);
    p.on('error', () => resolver(null));
    p.on('exit', () => {
      clearTimeout(plazo);
      const todo = Buffer.concat(trozos);
      resolver(todo.length === ancho * alto * 1.5 ? todo : null);
    });
  });
}
const punto = (nv12, ancho, alto, x, y) => {
  const uv = ancho * alto + (y >> 1) * ancho + (x & ~1);
  return [nv12[y * ancho + x], nv12[uv], nv12[uv + 1]];
};
// En YUV: el rojo tiene V alto y U bajo; el azul, al reves.
const esRojo = ([, u, v]) => v > 180 && u < 120;
const esAzul = ([, u, v]) => u > 180 && v < 130;

// Da los fotogramas a su ritmo, en bucle, hasta que `seguir()` diga que no.
function alimentar(fotogramas, fps, dar, seguir) {
  return (async () => {
    const inicio = Date.now();
    for (let i = 0; seguir(); i++) {
      const falta = inicio + (i * 1000) / fps - Date.now();
      if (falta > 0) await espera(falta);
      // Al dar la vuelta se empieza en clave: el video dura un numero entero de grupos.
      dar(fotogramas[i % fotogramas.length]);
    }
  })();
}

async function esperarA(condicion, ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (condicion()) return true; await espera(50); }
  return false;
}

(async () => {
  const p1 = planificarDos({ ancho: 1280, alto: 720 }, { ancho: 1920, alto: 1080 }, { dos: 'apilada' });
  comprobar('plan apilada: dos franjas de 16:9', p1.ancho === 1080 && p1.alto === 1216, `${p1.ancho}x${p1.alto}`);
  const p2 = planificarDos({ ancho: 1280, alto: 720 }, { ancho: 1920, alto: 1080 }, { dos: 'recuadro' });
  comprobar('plan recuadro: el tamano de la principal', p2.ancho === 1280 && p2.alto === 720, `${p2.ancho}x${p2.alto}`);

  const roja = fabricar('red', 1280, 720, 30, 4);
  // La segunda en 4K a 60, como un iPhone a tope: es el caso que mas pesa.
  const azul = fabricar('blue', 3840, 2160, 60, 4);

  const lineas = [];
  const registro = { log: (...a) => lineas.push(a.join(' ')), error: (...a) => lineas.push('ERROR ' + a.join(' ')) };
  const camara = new CamaraVirtual({ carpetaDatos: TMP, opciones: { dos: 'apilada' }, registro });
  camara.activar(true);

  let unaActiva = true, dosActiva = true;
  alimentar(roja, 30, (f) => camara.escribir(f, 30), () => unaActiva);
  alimentar(azul, 60, (f) => camara.escribirSegunda(f), () => dosActiva);

  // --- Apilada ---
  let listo = await esperarA(() => camara.estado().conSegunda && camara.estado().tamano === '1080x1216', 20000);
  comprobar('las dos camaras salen compuestas a 1080x1216', listo, JSON.stringify(camara.estado()));
  await espera(2500);
  let foto = await leerCamara(1080, 1216);
  comprobar('otra aplicacion la abre a 1080x1216', Boolean(foto));
  if (foto) {
    comprobar('arriba, la principal (roja)', esRojo(punto(foto, 1080, 1216, 540, 300)), punto(foto, 1080, 1216, 540, 300).join(','));
    comprobar('abajo, la segunda (azul)', esAzul(punto(foto, 1080, 1216, 540, 900)), punto(foto, 1080, 1216, 540, 900).join(','));
  }

  // Sin acumular retraso con la segunda al doble de ritmo: lo que tarda en verse
  // un cambio en la principal no puede crecer con el tiempo.
  await espera(6000);
  const cola = camara.ffmpeg && camara.ffmpeg.proceso ? camara.ffmpeg.proceso.stdin.writableLength : -1;
  const colaDos = camara.ffmpeg && camara.ffmpeg.entradaDos ? camara.ffmpeg.entradaDos.writableLength : -1;
  comprobar('ffmpeg va al dia con las dos (colas vacias)', cola >= 0 && cola < 200000 && colaDos >= 0 && colaDos < 400000, `principal ${cola} bytes, segunda ${colaDos} bytes`);

  // --- Recuadro ---
  camara.configurar({ dos: 'recuadro' });
  listo = await esperarA(() => camara.estado().conSegunda && camara.estado().tamano === '1280x720', 20000);
  comprobar('cambia a recuadro (1280x720)', listo, JSON.stringify(camara.estado()));
  await espera(2500);
  foto = await leerCamara(1280, 720);
  if (foto) {
    comprobar('fondo, la principal (roja)', esRojo(punto(foto, 1280, 720, 200, 200)), punto(foto, 1280, 720, 200, 200).join(','));
    comprobar('esquina, la segunda (azul)', esAzul(punto(foto, 1280, 720, 1100, 600)), punto(foto, 1280, 720, 1100, 600).join(','));
  } else comprobar('otra aplicacion la abre a 1280x720', false);

  // --- La segunda se va: la principal sigue sola ---
  dosActiva = false;
  camara.cortarSegunda();
  listo = await esperarA(() => camara.estado().enMarcha && !camara.estado().conSegunda, 20000);
  comprobar('sin la segunda, sigue la principal sola', listo, JSON.stringify(camara.estado()));
  await espera(2500);
  foto = await leerCamara(1280, 720);
  comprobar('y se ve entera (roja tambien en la esquina)', Boolean(foto) && esRojo(punto(foto, 1280, 720, 1100, 600)),
    foto ? punto(foto, 1280, 720, 1100, 600).join(',') : 'sin imagen');

  unaActiva = false;
  camara.detener();
  await espera(500);
  const errores = lineas.filter((l) => l.startsWith('ERROR'));
  comprobar('sin errores en el registro', errores.length === 0, errores.slice(0, 3).join(' | '));
  console.log('\n' + lineas.filter((l) => !/virtual:/.test(l)).join('\n'));
  console.log(fallos ? `\n${fallos} comprobacion(es) fallan` : '\nTodo bien');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* da igual */ }
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
