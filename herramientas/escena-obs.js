// Construye la escena "Estudio" en las colecciones de OBS de Nexo:
// captura de pantalla de fondo + la camara de Nexo en un recuadro pequeno.
//
// Se edita el JSON directamente porque OBS solo lo relee al arrancar; hay que
// hacerlo con OBS cerrado o al salir lo sobrescribe con lo que tenga en memoria.
//
// Aritmetica de OBS 30+: cada item guarda `pos`/`scale` en pixeles y ademas
// `pos_rel`/`scale_rel` normalizados contra `scale_ref`. Si no cuadran, OBS
// coloca la fuente en otro sitio al abrir. Las formulas estan verificadas
// contra la coleccion que ya existia:
//     pos_rel.x = (pos.x - W/2) / (H/2)
//     pos_rel.y = (pos.y - H/2) / (H/2)
// con W,H = lienzo. Para pos {0,0} en 1920x1080 da {-1.7777, -1}, que es
// exactamente lo que tenia guardado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(process.env.APPDATA, 'obs-studio', 'basic');

// El identificador del monitor, tal y como lo tenia la coleccion anterior.
const MONITOR_ID =
  '\\\\?\\DISPLAY#CMN15F5#5&2f2132f6&0&UID256#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}';

const PERFILES = [
  { coleccion: 'Nexo Vertical', W: 1080, H: 1920, camara: 'Nexo 9:16' },
  { coleccion: 'Nexo Horizontal', W: 1920, H: 1080, camara: 'Nexo 16:9' },
];

const uuid = () => crypto.randomUUID();

function item({ nombre, source_uuid, id, W, H, x, y, escalaX, escalaY }) {
  return {
    name: nombre,
    source_uuid,
    visible: true,
    locked: false,
    rot: 0.0,
    scale_ref: { x: W, y: H },
    align: 5, // arriba-izquierda: pos es la esquina superior izquierda
    bounds_type: 0,
    bounds_align: 0,
    bounds_crop: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    pos: { x, y },
    pos_rel: { x: (x - W / 2) / (H / 2), y: (y - H / 2) / (H / 2) },
    scale: { x: escalaX, y: escalaY },
    scale_rel: { x: escalaX, y: escalaY },
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

for (const { coleccion, W, H, camara } of PERFILES) {
  const ruta = path.join(BASE, 'scenes', coleccion + '.json');
  if (!fs.existsSync(ruta)) {
    console.log(`SALTADA ${coleccion}: no existe ${ruta}`);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  j.sources = j.sources || [];

  // --- fuente de pantalla (se reutiliza si ya estaba) ---
  let pantalla = j.sources.find((s) => s.id === 'monitor_capture');
  if (!pantalla) {
    pantalla = {
      prev_ver: 537001986,
      name: 'Pantalla',
      uuid: uuid(),
      id: 'monitor_capture',
      versioned_id: 'monitor_capture',
      settings: { monitor_id: MONITOR_ID, capture_cursor: true },
      mixers: 0,
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
    j.sources.push(pantalla);
  }

  const cam = j.sources.find((s) => s.id === 'browser_source' && s.name === camara);
  if (!cam) {
    console.log(`SALTADA ${coleccion}: no encuentro la fuente de navegador "${camara}"`);
    continue;
  }

  // --- geometria ---
  // La pantalla es 1920x1080; se escala para cubrir el ancho del lienzo y se
  // centra en vertical. En 16:9 encaja exacto; en 9:16 deja bandas arriba y
  // abajo, que es inevitable metiendo una pantalla apaisada en un lienzo alto.
  const escPantalla = W / 1920;
  const altoPantalla = 1080 * escPantalla;
  const yPantalla = Math.round((H - altoPantalla) / 2);

  // La camara ocupa un cuarto del ancho del lienzo, abajo a la derecha.
  const margen = Math.round(W * 0.03);
  const anchoCam = Math.round(W * 0.25);
  const escCam = anchoCam / W; // la fuente de navegador ya tiene el tamano del lienzo
  const altoCam = Math.round(H * escCam);

  const items = [
    // El primero del array es la capa de ABAJO en OBS.
    item({
      nombre: pantalla.name,
      source_uuid: pantalla.uuid,
      id: 1,
      W, H,
      x: 0,
      y: yPantalla,
      escalaX: escPantalla,
      escalaY: escPantalla,
    }),
    item({
      nombre: cam.name,
      source_uuid: cam.uuid,
      id: 2,
      W, H,
      x: W - anchoCam - margen,
      y: H - altoCam - margen,
      escalaX: escCam,
      escalaY: escCam,
    }),
  ];

  // --- escena ---
  const NOMBRE_ESCENA = 'Estudio';
  let escena = j.sources.find((s) => s.id === 'scene' && s.name === NOMBRE_ESCENA);
  if (!escena) {
    const modelo = j.sources.find((s) => s.id === 'scene');
    escena = {
      prev_ver: 537001986,
      name: NOMBRE_ESCENA,
      uuid: uuid(),
      id: 'scene',
      versioned_id: 'scene',
      settings: {},
      mixers: 0,
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
      canvas_uuid: modelo ? modelo.canvas_uuid : undefined,
      private_settings: {},
    };
    j.sources.push(escena);
  }
  escena.settings = { id_counter: 3, custom_size: false, items };

  // Que aparezca en la lista y quede seleccionada.
  j.scene_order = j.scene_order || [];
  if (!j.scene_order.some((e) => e.name === NOMBRE_ESCENA)) {
    j.scene_order.push({ name: NOMBRE_ESCENA });
  }
  j.current_scene = NOMBRE_ESCENA;
  j.current_program_scene = NOMBRE_ESCENA;

  fs.writeFileSync(ruta, JSON.stringify(j, null, 4), 'utf8');

  console.log(`${coleccion} (${W}x${H})`);
  console.log(`   pantalla : ${Math.round(1920 * escPantalla)}x${Math.round(altoPantalla)} en (0, ${yPantalla})`);
  console.log(`   camara   : ${anchoCam}x${altoCam} en (${W - anchoCam - margen}, ${H - altoCam - margen})`);
  console.log(`   escenas  : ${j.scene_order.map((e) => e.name).join(', ')}`);
}
