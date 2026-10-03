// Deja el audio de FL Studio en las escenas "Estudio" de OBS por ReaStream, y
// retira la fuente antigua de ASIO Link Pro.
//
// Por que ReaStream y no ASIO Link Pro: ASIO Link Pro estaba en version de
// prueba, y la prueba corta el sonido a proposito (lo dice su propio manual);
// ya no se puede comprar porque la web del fabricante no existe. FL va ahora
// directo por el ASIO de la M-Audio, con la misma latencia medida (unos 20 ms
// ida y vuelta), y el plugin ReaStream (gratuito, de Cockos) al final del Master
// manda una copia a OBS por 127.0.0.1 con el identificador "nexo-fl".
//
// Por que no "captura de audio de aplicacion": el ASIO va directo al hardware
// sin pasar por Windows, asi que no hay nada que capturar. Y FL Studio ASIO,
// que si pasa por Windows, mide unos 130 ms ida y vuelta: inservible para
// cantar con retorno.
//
// En OBS, ReaStream recibe dentro de un filtro VST, y un filtro necesita una
// fuente de audio que le marque el ritmo. Se usa la entrada de la propia M-Audio
// (por WDM, que funciona a la vez que el ASIO): asi comparte reloj con FL y no
// hay deriva. Una puerta con los umbrales a 0 dB la deja muda, de modo que solo
// suena lo que llega de FL.
//
// La fuente se configura una vez a mano en una coleccion (el estado de
// ReaStream va en un bloque binario del plugin) y este script la copia a las
// demas. OBS solo relee esto al arrancar, asi que hay que ejecutarlo con OBS
// cerrado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(process.env.APPDATA, 'obs-studio', 'basic', 'scenes');

const NOMBRE_FUENTE = 'FL Studio (ReaStream)';
const NOMBRE_ANTIGUA = 'FL Studio (ASIO Link Pro)';
const ESCENA = 'Estudio';

const COLECCIONES = [
  { archivo: 'Nexo Vertical.json', W: 1080, H: 1920 },
  { archivo: 'Nexo Horizontal.json', W: 1920, H: 1080 },
];

// --dispositivo <id>: apunta la entrada de soporte a otra interfaz. El id es el
// de Windows ("{0.0.1.00000000}.{guid}"), distinto en cada PC y en cada
// interfaz; sin esto, en otro PC la fuente apuntaria a la M-Audio de este y OBS
// no recibiria nada. Lo calcula herramientas\instalar-nexo.ps1.
const iDispositivo = process.argv.indexOf('--dispositivo');
const DISPOSITIVO = iDispositivo > 0 ? process.argv[iDispositivo + 1] : null;
if (iDispositivo > 0 && !/^\{0\.0\.1\.\d+\}\.\{[0-9a-f-]{36}\}$/i.test(DISPOSITIVO || '')) {
  console.error(`--dispositivo no parece un id de entrada de Windows: ${DISPOSITIVO}`);
  process.exit(1);
}

const leer = (archivo) => JSON.parse(fs.readFileSync(path.join(BASE, archivo), 'utf8'));
const existe = (archivo) => fs.existsSync(path.join(BASE, archivo));

// --- modelo: la primera coleccion que ya tenga la fuente configurada --------
let modelo = null;
for (const { archivo } of COLECCIONES) {
  if (!existe(archivo)) continue;
  const fuente = leer(archivo).sources.find((s) => s.name === NOMBRE_FUENTE);
  if (fuente) {
    modelo = { archivo, fuente };
    break;
  }
}
if (!modelo) {
  console.error(
    `No hay ninguna coleccion con "${NOMBRE_FUENTE}". Creala primero en OBS: ` +
      'captura de entrada de audio de la M-Audio, con una puerta a 0 dB y ' +
      'despues un filtro VST reastream-standalone en modo recibir, "nexo-fl".'
  );
  process.exit(1);
}
console.log(`modelo: "${NOMBRE_FUENTE}" de ${modelo.archivo}`);

// Copia con identificadores nuevos: cada coleccion lleva los suyos.
function copiarFuente(fuente) {
  const copia = JSON.parse(JSON.stringify(fuente));
  copia.uuid = crypto.randomUUID();
  for (const f of copia.filters || []) f.uuid = crypto.randomUUID();
  return copia;
}

function itemDeEscena(fuente, id, W, H) {
  return {
    name: fuente.name,
    source_uuid: fuente.uuid,
    visible: true,
    locked: false,
    rot: 0.0,
    scale_ref: { x: W, y: H },
    align: 5,
    bounds_type: 0,
    bounds_align: 0,
    bounds_crop: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    pos: { x: 0.0, y: 0.0 },
    pos_rel: { x: -(W / 2) / (H / 2), y: -1.0 },
    scale: { x: 1.0, y: 1.0 },
    scale_rel: { x: 1.0, y: 1.0 },
    bounds: { x: 0.0, y: 0.0 },
    bounds_rel: { x: 0.0, y: 0.0 },
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
    private_settings: {},
  };
}

for (const { archivo, W, H } of COLECCIONES) {
  if (!existe(archivo)) {
    console.log(`SALTADA ${archivo}: no existe`);
    continue;
  }
  const ruta = path.join(BASE, archivo);
  const j = leer(archivo);
  j.sources = j.sources || [];

  const escena = j.sources.find((s) => s.id === 'scene' && s.name === ESCENA);
  if (!escena) {
    console.log(`SALTADA ${archivo}: no encuentro la escena "${ESCENA}"`);
    continue;
  }
  const items = (escena.settings.items = escena.settings.items || []);

  // --- fuente ReaStream ---------------------------------------------------
  let fuente = j.sources.find((s) => s.name === NOMBRE_FUENTE);
  if (!fuente) {
    fuente = copiarFuente(modelo.fuente);
    j.sources.push(fuente);
    console.log(`   anadida "${NOMBRE_FUENTE}"`);
  }
  if (!items.some((it) => it.source_uuid === fuente.uuid)) {
    const siguienteId = Math.max(0, ...items.map((it) => it.id || 0)) + 1;
    items.push(itemDeEscena(fuente, siguienteId, W, H));
    escena.settings.id_counter = siguienteId + 1;
  }
  if (DISPOSITIVO) {
    fuente.settings = { ...(fuente.settings || {}), device_id: DISPOSITIVO };
    console.log(`   soporte de "${NOMBRE_FUENTE}" -> ${DISPOSITIVO}`);
  }

  // --- la antigua, oculta y en silencio -----------------------------------
  // No se borra: si algun dia vuelve ASIO Link Pro basta con mostrarla. Oculta
  // ya no suena ni aparece en el mezclador; el silencio es por si alguien la
  // muestra sin querer, que no se sume a la nueva.
  const antigua = j.sources.find((s) => s.name === NOMBRE_ANTIGUA);
  if (antigua) {
    antigua.muted = true;
    for (const it of items) if (it.source_uuid === antigua.uuid) it.visible = false;
    console.log(`   "${NOMBRE_ANTIGUA}" oculta y en silencio`);
  }

  fs.writeFileSync(ruta, JSON.stringify(j, null, 4), 'utf8');
  console.log(`${archivo}: listo`);
}
