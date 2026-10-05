'use strict';

// Prueba de la camara de Nexo (nexo-desktop/src/main/camara-virtual.js) sin
// iPhone: fabrica con ffmpeg un video H.264 como el que manda Nexo Cam, se lo
// da a la camara al ritmo real y comprueba lo que sale por "OBS Virtual
// Camera" leyendolo con otro programa.
//
//   node herramientas/prueba-camara-virtual.js
//
// Necesita ffmpeg y OBS instalado (es quien registra la camara virtual). Con
// Nexo Desktop abierto y su camara activa da "ocupada": cierralo antes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  CamaraVirtual, planificar, extraerSps, tamanoDeSps,
} = require('../nexo-desktop/src/main/camara-virtual');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-prueba-camara-'));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
function comprobar(nombre, bien, detalle = '') {
  if (!bien) fallos++;
  console.log(`${bien ? ' OK ' : 'FALLA'}  ${nombre}${detalle ? '  (' + detalle + ')' : ''}`);
}

// Video de ensayo: sin fotogramas B, una clave cada 2 s con su SPS/PPS delante
// y un delimitador por fotograma para poder trocearlo.
function fabricar(ancho, alto, segundos, extra = []) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${ancho}x${alto}:rate=30`,
    '-t', String(segundos), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '60',
    '-x264-params', 'aud=1:repeat-headers=1', ...extra,
    '-f', 'h264', 'pipe:1',
  ], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg no pudo fabricar el video: ' + r.stderr);
  return r.stdout;
}

// Trocea por los delimitadores y los quita: Nexo Cam no los manda.
function trocear(flujo) {
  const cortes = [];
  for (let i = 0; i + 5 < flujo.length; i++) {
    if (flujo[i] === 0 && flujo[i + 1] === 0 && flujo[i + 2] === 0 && flujo[i + 3] === 1 && (flujo[i + 4] & 0x1f) === 9) {
      cortes.push(i);
    }
  }
  const fotogramas = [];
  for (let k = 0; k < cortes.length; k++) {
    const datos = flujo.subarray(cortes[k] + 6, cortes[k + 1] ?? flujo.length);
    fotogramas.push({ datos, clave: Boolean(extraerSps(datos)) });
  }
  return fotogramas;
}

// Un fotograma de la camara, leido como lo haria cualquier aplicacion. Sin
// bloquear: mientras tanto hay que seguir dando video a la camara.
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

// Color (Y, U, V) de un punto de un fotograma NV12.
function punto(nv12, ancho, alto, x, y) {
  const uv = ancho * alto + (y >> 1) * ancho + (x & ~1);
  return [nv12[y * ancho + x], nv12[uv], nv12[uv + 1]];
}
const cerca = (a, b, margen = 12) => a.every((v, i) => Math.abs(v - b[i]) <= margen);

async function alimentar(camara, fotogramas, desde, hasta, tiempos) {
  const inicio = Date.now();
  for (let i = desde; i < hasta; i++) {
    const cuando = inicio + ((i - desde) * 1000) / 30;
    const falta = cuando - Date.now();
    if (falta > 0) await espera(falta);
    if (tiempos) tiempos[i] = Date.now();
    camara.escribir(fotogramas[i], 30);
  }
}

async function esperarA(condicion, ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await espera(50);
  }
  return false;
}

(async () => {
  // --- 1. Tamano leido de la SPS ---
  for (const [w, h, extra] of [
    [1280, 720, []], [720, 1280, []], [1920, 1080, []], [3840, 2160, []], [640, 480, []],
    [1280, 720, ['-profile:v', 'baseline']], [1920, 1080, ['-profile:v', 'high']],
  ]) {
    const f = trocear(fabricar(w, h, 0.1, extra))[0];
    let t = null;
    try { t = tamanoDeSps(extraerSps(f.datos)); } catch (e) { t = { error: e.message }; }
    comprobar(`SPS ${w}x${h} ${extra.join(' ')}`, t.ancho === w && t.alto === h, JSON.stringify(t));
  }

  // --- 2. Planes ---
  const casos = [
    [{ ancho: 1280, alto: 720 }, {}, '1280x720', 'format=nv12'],
    [{ ancho: 1280, alto: 720 }, { encuadre: '1:1' }, '720x720', 'crop=720:720,format=nv12'],
    [{ ancho: 1280, alto: 720 }, { encuadre: '9:16' }, '404x720', 'crop=404:720,format=nv12'],
    [{ ancho: 1280, alto: 720 }, { giro: 90, espejo: true }, '720x1280', 'transpose=1,hflip,format=nv12'],
    [{ ancho: 3840, alto: 2160 }, {}, '1920x1080', 'scale=1920:1080:flags=bilinear,format=nv12'],
  ];
  for (const [origen, opciones, tamano, filtros] of casos) {
    const p = planificar(origen, opciones);
    comprobar(`plan ${origen.ancho}x${origen.alto} ${JSON.stringify(opciones)}`,
      `${p.ancho}x${p.alto}` === tamano && p.filtros === filtros, `${p.ancho}x${p.alto} ${p.filtros}`);
  }

  // --- 3. La camara en marcha ---
  const horizontal = trocear(fabricar(1280, 720, 12));
  const vertical = trocear(fabricar(720, 1280, 6));
  comprobar('video de ensayo troceado', horizontal.length === 360 && horizontal[0].clave && !horizontal[1].clave,
    `${horizontal.length} fotogramas`);

  const lineas = [];
  const registro = { log: (...a) => lineas.push(a.join(' ')), error: (...a) => lineas.push('ERROR ' + a.join(' ')) };
  const camara = new CamaraVirtual({ carpetaDatos: TMP, registro, traza: true });
  const publicados = new Map();
  camara.on('traza', (t) => publicados.set(t.numero, t.ms));

  camara.activar(true);
  const tiempos = [];
  tiempos[0] = Date.now();
  camara.escribir(horizontal[0], 30);
  const arranco = await esperarA(() => camara.estado().enMarcha, 20000);
  comprobar('la camara arranca', arranco, camara.estado().motivo || `${Date.now() - tiempos[0]} ms, ${camara.estado().tamano}`);
  if (!arranco) {
    console.log(lineas.join('\n'));
    camara.detener();
    process.exit(1);
  }

  const leyendo = (async () => {
    await espera(2500);
    return leerCamara(1280, 720);
  })();
  await alimentar(camara, horizontal, 1, 240, tiempos);
  const foto = await leyendo;
  comprobar('otra aplicacion la abre a 1280x720', Boolean(foto));
  if (foto) {
    // testsrc2: barras rojo, verde, amarillo, azul, magenta, cian (BT.601).
    comprobar('rojo a la izquierda', cerca(punto(foto, 1280, 720, 100, 650), [81, 90, 240]), punto(foto, 1280, 720, 100, 650).join(','));
    comprobar('cian a la derecha', cerca(punto(foto, 1280, 720, 1180, 650), [170, 166, 16]), punto(foto, 1280, 720, 1180, 650).join(','));
  }

  await espera(300);
  const retrasos = [];
  for (let i = 60; i < 240; i++) {
    if (publicados.has(i + 1)) retrasos.push(publicados.get(i + 1) - tiempos[i]);
  }
  retrasos.sort((a, b) => a - b);
  const mediana = retrasos[retrasos.length >> 1];
  const peor = retrasos[retrasos.length - 1];
  comprobar('salen todos los fotogramas', publicados.size >= 239, `${publicados.size} de 240`);
  // Con el PC libre ronda los 40 ms. El margen es ancho porque con la CPU al
  // 100 % (medido con TikTok y dos navegadores abiertos) sube a 130 ms.
  comprobar('retraso de la camara por debajo de 150 ms', mediana < 150, `mediana ${mediana} ms, peor ${peor} ms`);

  // --- 4. Espejo: mismo tamano, solo cambia ffmpeg ---
  camara.configurar({ espejo: true });
  const leyendoEspejo = (async () => { await espera(2000); return leerCamara(1280, 720); })();
  await alimentar(camara, horizontal, 240, 360);
  const fotoEspejo = await leyendoEspejo;
  comprobar('con espejo, el rojo pasa a la derecha',
    Boolean(fotoEspejo) && cerca(punto(fotoEspejo, 1280, 720, 1180, 650), [81, 90, 240]),
    fotoEspejo ? punto(fotoEspejo, 1280, 720, 1180, 650).join(',') : 'sin imagen');
  camara.configurar({ espejo: false });

  // --- 5. El iPhone cambia a vertical: la camara cambia de tamano ---
  const leyendoVertical = (async () => { await espera(3000); return leerCamara(720, 1280); })();
  await alimentar(camara, vertical, 0, 150);
  comprobar('cambia a vertical', camara.estado().tamano === '720x1280', camara.estado().tamano);
  const fotoVertical = await leyendoVertical;
  comprobar('otra aplicacion la abre a 720x1280',
    Boolean(fotoVertical) && cerca(punto(fotoVertical, 720, 1280, 60, 1200), [81, 90, 240]),
    fotoVertical ? punto(fotoVertical, 720, 1280, 60, 1200).join(',') : 'sin imagen');

  // --- 6. Se corta el video: a negro a los 3 s ---
  camara.cortar();
  await espera(4500);
  const fotoNegra = await leerCamara(720, 1280);
  comprobar('sin video, la camara queda en negro',
    Boolean(fotoNegra) && cerca(punto(fotoNegra, 720, 1280, 360, 640), [16, 128, 128], 3),
    fotoNegra ? punto(fotoNegra, 720, 1280, 360, 640).join(',') : 'sin imagen');

  // --- 7. Apagar suelta la camara ---
  camara.detener();
  await espera(1500);
  const otra = new CamaraVirtual({ carpetaDatos: TMP, registro });
  otra.activar(true);
  otra.escribir(horizontal[0], 30);
  const vuelve = await esperarA(() => camara.estado().motivo || otra.estado().enMarcha, 8000);
  comprobar('tras apagar, se puede volver a encender', vuelve && otra.estado().enMarcha, otra.estado().motivo || '');
  otra.detener();
  await espera(800);

  const errores = lineas.filter((l) => l.startsWith('ERROR'));
  comprobar('sin errores en el registro', errores.length === 0, errores.slice(0, 3).join(' | '));
  console.log('\n' + lineas.filter((l) => !l.startsWith('ERROR')).join('\n'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* da igual */ }
  console.log(fallos ? `\n${fallos} comprobacion(es) fallaron` : '\nTodo bien');
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
