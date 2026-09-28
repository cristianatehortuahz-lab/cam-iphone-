// Anade a las escenas "Estudio" de OBS la captura del audio de FL Studio a
// traves de ASIO Link Pro, y limpia fuentes de microfono duplicadas.
//
// Por que por ASIO Link Pro y no con "captura de aplicacion": la interfaz
// M-Audio tiene que ir por ASIO para monitorizar en vivo sin latencia, y ASIO
// es exclusivo: el audio va directo al hardware sin pasar por Windows, asi que
// no hay ninguna sesion WASAPI que OBS pueda capturar. ASIO Link Pro se pone en
// medio y ademas publica buses WDM virtuales ("Mix 01".."Mix 04") de los que
// OBS si puede grabar.
//
// OBS solo relee esto al arrancar, asi que hay que ejecutarlo con OBS cerrado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(process.env.APPDATA, 'obs-studio', 'basic', 'scenes');

// Bus virtual de ASIO Link Pro, leido del registro de Windows.
// (MMDevices\Audio\Capture; interfaz "ASIOVADPRO Driver")
const MIX = {
  nombre: 'Mix 01',
  id: '{0.0.1.00000000}.{d8869794-f453-47e8-9b87-6e184f66af38}',
};

const NOMBRE_FUENTE = 'FL Studio (ASIO Link Pro)';
const ESCENA = 'Estudio';

const COLECCIONES = [
  { archivo: 'Nexo Vertical.json', W: 1080, H: 1920 },
  { archivo: 'Nexo Horizontal.json', W: 1920, H: 1080 },
];

for (const { archivo, W, H } of COLECCIONES) {
  const ruta = path.join(BASE, archivo);
  if (!fs.existsSync(ruta)) {
    console.log(`SALTADA ${archivo}: no existe`);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  j.sources = j.sources || [];

  const escena = j.sources.find((s) => s.id === 'scene' && s.name === ESCENA);
  if (!escena) {
    console.log(`SALTADA ${archivo}: no encuentro la escena "${ESCENA}"`);
    continue;
  }

  // --- limpiar microfonos huerfanos -------------------------------------
  // Fuentes de audio que no aparecen en ninguna escena. Estaban de antes y en
  // directo se traducen en pistas duplicadas en el mezclador.
  const usados = new Set();
  for (const s of j.sources) {
    if (s.id !== 'scene') continue;
    for (const it of (s.settings && s.settings.items) || []) usados.add(it.source_uuid);
  }
  const huerfanos = j.sources.filter(
    (s) => s.id === 'wasapi_input_capture' && !usados.has(s.uuid) && s.name !== NOMBRE_FUENTE
  );
  if (huerfanos.length) {
    for (const h of huerfanos) console.log(`   quitada fuente huerfana: "${h.name}"`);
    j.sources = j.sources.filter((s) => !huerfanos.includes(s));
  }

  // --- fuente de audio ---------------------------------------------------
  let audio = j.sources.find((s) => s.name === NOMBRE_FUENTE);
  if (!audio) {
    audio = {
      prev_ver: 537001986,
      name: NOMBRE_FUENTE,
      uuid: crypto.randomUUID(),
      id: 'wasapi_input_capture',
      versioned_id: 'wasapi_input_capture',
      settings: { device_id: MIX.id },
      mixers: 255,
      sync: 0,
      flags: 0,
      volume: 1.0,
      balance: 0.5,
      enabled: true,
      muted: false,
      'push-to-mute': false,
      'push-to-mute-delay': 0,
      'push-to-talk': false,
      'push-to-talk-delay': 0,
      hotkeys: {},
      deinterlace_mode: 0,
      deinterlace_field_order: 0,
      monitoring_type: 0,
      private_settings: {},
    };
    j.sources.push(audio);
  } else {
    audio.settings = audio.settings || {};
    audio.settings.device_id = MIX.id;
  }

  // --- meterla en la escena ---------------------------------------------
  const items = escena.settings.items || [];
  if (!items.some((it) => it.source_uuid === audio.uuid)) {
    const siguienteId = Math.max(0, ...items.map((it) => it.id || 0)) + 1;
    items.push({
      name: audio.name,
      source_uuid: audio.uuid,
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
      id: siguienteId,
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
    });
    escena.settings.items = items;
    escena.settings.id_counter = siguienteId + 1;
  }

  fs.writeFileSync(ruta, JSON.stringify(j, null, 4), 'utf8');
  console.log(`${archivo}: "${NOMBRE_FUENTE}" -> ${MIX.nombre}`);
}
