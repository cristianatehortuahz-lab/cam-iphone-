'use strict';

// Estudio en el PC. Recibe el video del iPhone, lo pasa por el motor de color,
// lo encuadra y lo entrega a OBS. Los ajustes de camara viajan al iPhone; los de
// imagen se aplican aqui y se replican a las demas salidas.

const $ = (id) => document.getElementById(id);

const elEscena = $('escena');
const elVideo = $('video');
const elLienzo = $('lienzo');
const elEstado = $('estado');
const elLuz = $('luz');
const elEspera = $('espera');
const elMedidor = $('medidor');
const elEnlace = $('enlace');
const elDireccion = $('direccion');

const elLente = $('lente');
const elResolucion = $('resolucion');
const elFps = $('fps');
const elHint = $('hint');
const elZoom = $('zoom');
const elExposicionCam = $('exposicion');
const elEnfoque = $('enfoque');
const elBalance = $('balance');
const elFormato = $('formato');
const elRecortar = $('recortar');
const elPreset = $('preset');

const elGuias = $('guias');
const elRecuadro = $('recuadro');
const elRejilla = $('rejilla');

const elLinterna = $('linterna');
const elEspejo = $('espejo');
const elRotar = $('rotar');
const elDatos = $('datos');
const elFoto = $('foto');
const elGrabar = $('grabar');
const elPantalla = $('pantalla');
const elPanel = $('panel');
const elGrabando = $('grabando');
const elCrono = $('crono');

let ws = null;
let pc = null;
let flujo = null;
let reconectar = null;

let grabadora = null;
let trozos = [];
let inicioGrabacion = 0;
let cronometro = null;
let ultimoInforme = null;

let verZonas = false;
let comparando = false;
let firmaLentes = '';

const procesador = new ProcesadorImagen(elVideo);
// El puente Nexo Desktop -> Electron necesita alcanzar el procesador para
// entregarle VideoFrame decodificados (ver puente.js). En navegador plano,
// asignarlo a window es inofensivo.
window.procesador = procesador;

// Lo que necesita puente.js para gobernar el estudio desde la ruta nativa. Son
// declaraciones de funcion, asi que ya estan izadas cuando se ejecuta esto.
window.pintarEstadoMovil = pintarEstadoMovil;
window.habilitarControles = habilitarControles;
elLienzo.replaceWith(procesador.canvas);
procesador.canvas.id = 'lienzo';
const elSalida = procesador.canvas;

if (!procesador.disponible) document.body.classList.add('sinGl');

const CONFIG_ICE = { iceServers: [], bundlePolicy: 'max-bundle' };

const ZONAS_UI = {
  '9:16': [
    { arriba: 0, alto: 0.09, izq: 0, ancho: 1 },
    { arriba: 0.78, alto: 0.22, izq: 0, ancho: 1 },
    { arriba: 0.35, alto: 0.43, izq: 0.82, ancho: 0.18 },
  ],
  '4:5': [{ arriba: 0.86, alto: 0.14, izq: 0, ancho: 1 }],
  '1:1': [],
  '16:9': [{ arriba: 0.88, alto: 0.12, izq: 0, ancho: 1 }],
};

// Cada fila del panel de imagen. Los limites (min/max) NO se repiten aqui: se
// leen de RANGOS (procesador.js), que es la fuente unica que ademas usa el
// shader para recortar. Aqui solo van titulo, paso de deslizador y formato.
const CONTROLES_IMAGEN = [
  { clave: 'exposicion', titulo: 'Exposicion', paso: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` },
  { clave: 'brillo', titulo: 'Brillo', paso: 0.01, fmt: (v) => pct(v) },
  { clave: 'contraste', titulo: 'Contraste', paso: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { clave: 'saturacion', titulo: 'Saturacion', paso: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { clave: 'vibrancia', titulo: 'Vibrancia', paso: 0.01, fmt: (v) => pct(v) },
  { clave: 'temperatura', titulo: 'Temperatura', paso: 0.01, fmt: (v) => (v === 0 ? 'neutra' : v > 0 ? `calida ${pct(v)}` : `fria ${pct(-v)}`) },
  { clave: 'tinte', titulo: 'Tinte', paso: 0.01, fmt: (v) => (v === 0 ? 'neutro' : v > 0 ? `verde ${pct(v)}` : `magenta ${pct(-v)}`) },
  { clave: 'sombras', titulo: 'Sombras', paso: 0.01, fmt: (v) => pct(v) },
  { clave: 'luces', titulo: 'Luces', paso: 0.01, fmt: (v) => pct(v) },
  { clave: 'gamma', titulo: 'Gamma', paso: 0.01, fmt: (v) => v.toFixed(2) },
  { clave: 'nitidez', titulo: 'Nitidez', paso: 0.02, fmt: (v) => pct(v) },
  { clave: 'desenfoque', titulo: 'Suavizado', paso: 0.05, fmt: (v) => pct(v / 2) },
  { clave: 'vineta', titulo: 'Vineta', paso: 0.02, fmt: (v) => pct(v) },
];

function pct(v) {
  return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

function marcarEstado(texto, clase) {
  elEstado.textContent = texto;
  elLuz.className = 'punto' + (clase ? ' ' + clase : '');
}

function habilitarControles(activos) {
  for (const el of [elLente, elResolucion, elFps, elHint, elFoto, elGrabar, elPantalla]) {
    el.disabled = !activos;
  }
  if (!activos) {
    elLinterna.disabled = true;
    elLente.innerHTML = '<option>Lente</option>';
    // Al vaciar la lista hay que olvidar tambien su firma. Si no, el siguiente
    // estado del iPhone se considera "sin cambios" y el desplegable se queda
    // con el texto de relleno para siempre.
    firmaLentes = '';
    for (const g of ['grupoZoom', 'grupoExposicion', 'grupoEnfoque']) $(g).classList.add('oculto');
  }
}

async function mostrarDireccion() {
  try {
    const info = await (await fetch('/api/info')).json();
    if (elDireccion) elDireccion.textContent = info.urlMovil;
    elEnlace.innerHTML = `${info.cable ? 'cable USB' : 'sin cable'} · <b>${info.urlMovil}</b>`;
  } catch {
    elEnlace.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Panel de correccion de imagen
// ---------------------------------------------------------------------------

const filas = new Map();

function construirPanelImagen() {
  const contenedor = $('deslizadores');
  for (const c of CONTROLES_IMAGEN) {
    const rango0 = RANGOS[c.clave];
    const fila = document.createElement('div');
    fila.className = 'deslizador';
    fila.innerHTML =
      `<label>${c.titulo} <span></span></label>` +
      `<input type="range" min="${rango0.min}" max="${rango0.max}" step="${c.paso}">`;
    const rango = fila.querySelector('input');
    const valor = fila.querySelector('span');

    rango.value = AJUSTES_NEUTROS[c.clave];
    valor.textContent = c.fmt(Number(rango.value));

    rango.addEventListener('input', () => {
      const v = Number(rango.value);
      valor.textContent = c.fmt(v);
      fila.classList.toggle('tocado', v !== AJUSTES_NEUTROS[c.clave]);
      procesador.aplicar({ [c.clave]: v });
      difundirImagen();
    });

    // Doble clic sobre la fila devuelve ese ajuste a su valor neutro.
    fila.addEventListener('dblclick', () => {
      rango.value = AJUSTES_NEUTROS[c.clave];
      rango.dispatchEvent(new Event('input'));
    });

    contenedor.appendChild(fila);
    filas.set(c.clave, { fila, rango, valor, def: c });
  }
}

function refrescarPanelImagen() {
  for (const [clave, f] of filas) {
    const v = procesador.ajustes[clave];
    if (document.activeElement !== f.rango) f.rango.value = v;
    f.valor.textContent = f.def.fmt(Number(v));
    f.fila.classList.toggle('tocado', Number(v) !== AJUSTES_NEUTROS[clave]);
  }
}

function difundirImagen() {
  enviar({ tipo: 'imagen', valores: procesador.ajustes });
  try {
    localStorage.setItem('camara-iphone-imagen', JSON.stringify(procesador.ajustes));
  } catch {
    /* almacenamiento lleno o bloqueado: no es critico */
  }
}

function cargarImagenGuardada() {
  try {
    const guardado = JSON.parse(localStorage.getItem('camara-iphone-imagen') || 'null');
    if (guardado) procesador.aplicar(guardado);
  } catch {
    /* dato corrupto: seguimos con los valores neutros */
  }
}

// ---------------------------------------------------------------------------
// Senalizacion
// ---------------------------------------------------------------------------

function enviar(mensaje) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje));
}

function ordenar(accion, valor) {
  // Por la ruta nativa (Nexo Cam por cable) el iPhone no esta en la
  // senalizacion WebSocket —no se registra como 'movil'—, asi que una orden
  // enviada por ahi no la recibe nadie. Va por el transporte de Nexo.
  if (window.nexoNativoActivo && window.nexo && window.nexo.enviarControl) {
    window.nexo.enviarControl({ accion, valor });
    return;
  }
  enviar({ tipo: 'control', accion, valor });
}

function conectar() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    clearTimeout(reconectar);
    enviar({ tipo: 'hola', rol: 'visor' });
    difundirImagen();
  };

  ws.onclose = () => {
    marcarEstado('Servidor detenido', 'error');
    cerrar();
    reconectar = setTimeout(conectar, 1500);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = async (evento) => {
    const msg = JSON.parse(evento.data);

    switch (msg.tipo) {
      case 'bienvenida':
        marcarEstado('Esperando al iPhone…', 'aviso');
        break;
      case 'movil-conectado':
        marcarEstado('iPhone conectado, negociando…', 'aviso');
        break;
      case 'movil-desconectado':
        marcarEstado('iPhone desconectado', 'error');
        cerrar();
        break;
      case 'oferta':
        await atenderOferta(msg);
        break;
      case 'ice':
        if (pc && msg.candidato) {
          try {
            await pc.addIceCandidate(msg.candidato);
          } catch {
            /* candidato fuera de tiempo */
          }
        }
        break;
      case 'estado':
        pintarEstadoMovil(msg);
        break;
    }
  };
}

function pintarEstadoMovil(msg) {
  const lentes = msg.lentes || [];
  // El iPhone publica su estado cada 2 s. Rehacer la lista cada vez cerraria el
  // desplegable en las narices del usuario, asi que solo se toca si cambio.
  const firma = lentes.map((l) => `${l.id}:${l.nombre}`).join('|');
  if (lentes.length && firma !== firmaLentes) {
    firmaLentes = firma;
    const seleccion = msg.lenteActual || elLente.value;
    elLente.innerHTML = '';
    for (const l of lentes) {
      const op = document.createElement('option');
      op.value = l.id;
      op.textContent = l.nombre;
      elLente.appendChild(op);
    }
    if (seleccion) elLente.value = seleccion;
  } else if (msg.lenteActual && document.activeElement !== elLente) {
    elLente.value = msg.lenteActual;
  }

  if (msg.hint && document.activeElement !== elHint) elHint.value = msg.hint;

  const cap = msg.capacidades || {};
  configurarDeslizador('grupoZoom', elZoom, $('valorZoom'), cap.zoom, (v) => `${v.toFixed(1)}x`);
  configurarDeslizador(
    'grupoExposicion',
    elExposicionCam,
    $('valorExposicion'),
    cap.exposicion,
    (v) => (v > 0 ? '+' : '') + v.toFixed(2)
  );

  $('grupoEnfoque').classList.toggle('oculto', !(cap.modosEnfoque?.length || cap.modosBalance?.length));
  rellenarLista(elEnfoque, cap.modosEnfoque, 'Enfoque');
  rellenarLista(elBalance, cap.modosBalance, 'Balance de blancos');

  elLinterna.disabled = !cap.linterna;

  if (!msg.transmitiendo) marcarEstado('iPhone conectado, sin transmitir', 'aviso');
}

function configurarDeslizador(idGrupo, deslizador, etiqueta, rango, formato) {
  const grupo = $(idGrupo);
  if (!rango) {
    grupo.classList.add('oculto');
    return;
  }
  grupo.classList.remove('oculto');
  deslizador.min = rango.min;
  deslizador.max = rango.max;
  deslizador.step = rango.step || (rango.max - rango.min) / 100;
  if (document.activeElement !== deslizador) {
    deslizador.value = rango.valor;
    etiqueta.textContent = formato(Number(rango.valor));
  }
}

function rellenarLista(select, valores, titulo) {
  if (!valores?.length) {
    select.classList.add('oculto');
    return;
  }
  select.classList.remove('oculto');
  if (select.options.length === valores.length + 1) return;
  select.innerHTML = `<option value="">${titulo}: automatico</option>`;
  for (const v of valores) {
    const op = document.createElement('option');
    op.value = v;
    op.textContent = `${titulo}: ${v}`;
    select.appendChild(op);
  }
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------

async function atenderOferta(msg) {
  cerrar();
  pc = new RTCPeerConnection(CONFIG_ICE);

  pc.ontrack = (e) => {
    flujo = e.streams[0];
    elVideo.srcObject = flujo;
    elEspera.classList.add('oculto');
    habilitarControles(true);
    elVideo.play().then(() => procesador.iniciar()).catch(() => procesador.iniciar());
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) enviar({ tipo: 'ice', para: msg.de, candidato: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') marcarEstado('En directo', 'ok');
    else if (pc.connectionState === 'failed') marcarEstado('Conexion fallida', 'error');
  };

  await pc.setRemoteDescription(msg.sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  enviar({ tipo: 'respuesta', para: msg.de, sdp: pc.localDescription });
}

function cerrar() {
  if (grabadora && grabadora.state !== 'inactive') pararGrabacion();
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  flujo = null;
  elVideo.srcObject = null;

  // Si el video esta entrando por el transporte nativo (Nexo Cam por cable), lo
  // de arriba es todo lo que hay que desmontar: lo de abajo es estado de la
  // ruta WebRTC y no nos incumbe.
  //
  // Hace falta el guardia porque el iPhone conectado por cable NO aparece como
  // 'movil' en la senalizacion WebSocket, asi que esta funcion se llama como si
  // no hubiera nadie. Sin esto paraba el bucle de dibujo y volvia a tapar el
  // lienzo con la pantalla de espera mientras el video seguia llegando entero.
  if (window.nexoNativoActivo) return;

  procesador.parar();
  elEspera.classList.remove('oculto');
  elGuias.classList.add('oculto');
  habilitarControles(false);
}

// ---------------------------------------------------------------------------
// Encuadre
// ---------------------------------------------------------------------------

// El giro ya lo hace el shader, asi que aqui solo hay que respetar el 'contain'
// del lienzo, que ya viene con las dimensiones finales. Sin WebGL no hay lienzo
// (mediria 300x150), asi que se mide el video en crudo, igual que capturar().
function rectoContenido() {
  const cw = elEscena.clientWidth;
  const ch = elEscena.clientHeight;
  const vw = procesador.disponible ? elSalida.width : elVideo.videoWidth;
  const vh = procesador.disponible ? elSalida.height : elVideo.videoHeight;
  if (!vw || !vh) return null;

  const escala = Math.min(cw / vw, ch / vh);
  const w = vw * escala;
  const h = vh * escala;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function dibujarGuias() {
  const formato = elFormato.value;
  const recto = rectoContenido();
  const hayRejilla = !elRejilla.classList.contains('oculto');

  if (!recto) {
    elGuias.classList.add('oculto');
    return;
  }

  if (formato === 'libre') {
    elRecuadro.style.display = 'none';
    for (const viejo of elGuias.querySelectorAll('.zonaUi')) viejo.remove();
    elGuias.classList.toggle('oculto', !hayRejilla);
    if (hayRejilla) dibujarRejilla(recto);
    return;
  }

  elGuias.classList.remove('oculto');

  // Con el recorte aplicado, el lienzo YA tiene esa proporcion, asi que el
  // recuadro acabaria bordeando la imagen entera sin informar de nada. Se
  // oculta solo el borde: el resto de la funcion sigue igual, y las zonas de
  // interfaz y la rejilla se colocan solas donde toca, porque el rectangulo
  // calculado abajo coincide exactamente con la imagen.
  elRecuadro.style.display = elRecortar.checked ? 'none' : '';

  const [a, b] = formato.split(':').map(Number);
  const proporcion = a / b;

  let w = recto.w;
  let h = w / proporcion;
  if (h > recto.h) {
    h = recto.h;
    w = h * proporcion;
  }
  const x = recto.x + (recto.w - w) / 2;
  const y = recto.y + (recto.h - h) / 2;

  Object.assign(elRecuadro.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  elRecuadro.dataset.etiqueta = elFormato.selectedOptions[0].textContent;

  for (const viejo of elGuias.querySelectorAll('.zonaUi')) viejo.remove();
  if (verZonas) {
    for (const z of ZONAS_UI[formato] || []) {
      const div = document.createElement('div');
      div.className = 'zonaUi';
      Object.assign(div.style, {
        left: `${x + z.izq * w}px`,
        top: `${y + z.arriba * h}px`,
        width: `${z.ancho * w}px`,
        height: `${z.alto * h}px`,
      });
      elGuias.appendChild(div);
    }
  }

  dibujarRejilla({ x, y, w, h });
}

function dibujarRejilla(recto) {
  if (elRejilla.classList.contains('oculto')) return;
  elRejilla.innerHTML = '';
  for (let i = 1; i <= 2; i++) {
    const v = document.createElement('i');
    Object.assign(v.style, {
      left: `${recto.x + (recto.w * i) / 3}px`,
      top: `${recto.y}px`,
      width: '1px',
      height: `${recto.h}px`,
    });
    const h = document.createElement('i');
    Object.assign(h.style, {
      left: `${recto.x}px`,
      top: `${recto.y + (recto.h * i) / 3}px`,
      width: `${recto.w}px`,
      height: '1px',
    });
    elRejilla.append(v, h);
  }
}

// ---------------------------------------------------------------------------
// Medidor
// ---------------------------------------------------------------------------

async function actualizarMedidor() {
  if (!pc || elMedidor.classList.contains('oculto')) return;

  const informe = await pc.getStats();
  let entrada = null;
  let pareja = null;
  informe.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') entrada = s;
    if (s.type === 'candidate-pair' && s.state === 'succeeded') pareja = s;
  });
  if (!entrada) return;

  let kbps = 0;
  if (ultimoInforme && entrada.bytesReceived > ultimoInforme.bytes) {
    const seg = (entrada.timestamp - ultimoInforme.tiempo) / 1000;
    if (seg > 0) kbps = ((entrada.bytesReceived - ultimoInforme.bytes) * 8) / seg / 1000;
  }
  ultimoInforme = { bytes: entrada.bytesReceived, tiempo: entrada.timestamp };

  const ping = pareja?.currentRoundTripTime ? Math.round(pareja.currentRoundTripTime * 1000) : '—';
  const codec = (entrada.codecId && informe.get(entrada.codecId)?.mimeType?.split('/')[1]) || '—';
  const tasa = kbps > 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;

  elMedidor.innerHTML =
    `<b>${elSalida.width}x${elSalida.height}</b> · ${Math.round(entrada.framesPerSecond || 0)} fps\n` +
    `${tasa} · ${codec}\n` +
    `ping ${ping} ms · perdidos ${entrada.packetsLost || 0}\n` +
    `motor ${procesador.disponible ? 'GPU' : 'sin GPU'}`;
}

// ---------------------------------------------------------------------------
// Captura y grabacion (siempre desde el lienzo: salen ya corregidas)
// ---------------------------------------------------------------------------

function marcaTiempo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function capturar() {
  const fuente = procesador.disponible ? elSalida : elVideo;
  const vw = procesador.disponible ? elSalida.width : elVideo.videoWidth;
  const vh = procesador.disponible ? elSalida.height : elVideo.videoHeight;
  if (!vw) return;

  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;

  if (elFormato.value !== 'libre') {
    const [a, b] = elFormato.value.split(':').map(Number);
    const proporcion = a / b;
    if (vw / vh > proporcion) {
      sw = vh * proporcion;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / proporcion;
      sy = (vh - sh) / 2;
    }
  }

  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(sw);
  lienzo.height = Math.round(sh);
  lienzo.getContext('2d').drawImage(fuente, sx, sy, sw, sh, 0, 0, lienzo.width, lienzo.height);
  lienzo.toBlob((bl) => descargar(bl, `captura-${marcaTiempo()}.png`), 'image/png');
}

function empezarGrabacion() {
  if (!flujo) return;

  // Grabamos el lienzo, no el video original: asi el archivo lleva la
  // correccion aplicada. El audio se toma del flujo del iPhone.
  const fuente = procesador.disponible ? elSalida.captureStream(60) : flujo;
  const mezcla = new MediaStream([
    ...fuente.getVideoTracks(),
    ...flujo.getAudioTracks(),
  ]);

  const formatos = ['video/mp4;codecs=avc1', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
  const tipo = formatos.find((f) => MediaRecorder.isTypeSupported(f));
  if (!tipo) return;

  trozos = [];
  grabadora = new MediaRecorder(mezcla, { mimeType: tipo, videoBitsPerSecond: 16e6 });
  grabadora.ondataavailable = (e) => e.data.size && trozos.push(e.data);
  grabadora.onstop = () => {
    const ext = tipo.startsWith('video/mp4') ? 'mp4' : 'webm';
    descargar(new Blob(trozos, { type: tipo }), `video-${marcaTiempo()}.${ext}`);
  };
  grabadora.start(1000);

  inicioGrabacion = Date.now();
  elGrabando.classList.remove('oculto');
  elGrabar.textContent = 'Detener';
  elGrabar.classList.add('activo');
  cronometro = setInterval(() => {
    const s = Math.floor((Date.now() - inicioGrabacion) / 1000);
    elCrono.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function pararGrabacion() {
  grabadora?.stop();
  grabadora = null;
  clearInterval(cronometro);
  elGrabando.classList.add('oculto');
  elGrabar.textContent = 'Grabar';
  elGrabar.classList.remove('activo');
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

elLente.addEventListener('change', () => ordenar('cambiar-lente', elLente.value));
elResolucion.addEventListener('change', () => ordenar('cambiar-resolucion', elResolucion.value));
elFps.addEventListener('change', () => ordenar('cambiar-fps', elFps.value));
elHint.addEventListener('change', () => ordenar('hint', elHint.value));

elLinterna.addEventListener('click', () => {
  elLinterna.classList.toggle('activo');
  ordenar('linterna');
});

elZoom.addEventListener('input', () => {
  $('valorZoom').textContent = `${Number(elZoom.value).toFixed(1)}x`;
  ordenar('zoom', elZoom.value);
});

elExposicionCam.addEventListener('input', () => {
  const v = Number(elExposicionCam.value);
  $('valorExposicion').textContent = (v > 0 ? '+' : '') + v.toFixed(2);
  ordenar('exposicion', elExposicionCam.value);
});

elEnfoque.addEventListener('change', () => elEnfoque.value && ordenar('enfoque', elEnfoque.value));
elBalance.addEventListener('change', () => elBalance.value && ordenar('balance', elBalance.value));

elPreset.addEventListener('change', () => {
  // Un look es un punto de partida: parte de neutro y aplica sus cambios,
  // conservando el giro y el espejo, que son encuadre y no color.
  const { espejo, rotacion } = procesador.ajustes;
  procesador.reiniciar();
  procesador.aplicar({ ...PRESETES[elPreset.value], espejo, rotacion });
  refrescarPanelImagen();
  difundirImagen();
});

$('reiniciarImagen').addEventListener('click', () => {
  const { espejo, rotacion } = procesador.ajustes;
  procesador.reiniciar();
  procesador.aplicar({ espejo, rotacion });
  elPreset.value = 'neutro';
  refrescarPanelImagen();
  difundirImagen();
});

// Mantener pulsado muestra el original, para comparar antes y despues.
const botonComparar = $('compararImagen');
let guardadoComparacion = null;

function verOriginal(activar) {
  if (activar === comparando) return;
  comparando = activar;
  if (activar) {
    guardadoComparacion = { ...procesador.ajustes };
    const { espejo, rotacion } = procesador.ajustes;
    procesador.reiniciar();
    procesador.aplicar({ espejo, rotacion });
  } else if (guardadoComparacion) {
    procesador.aplicar(guardadoComparacion);
  }
  botonComparar.classList.toggle('activo', activar);
}

botonComparar.addEventListener('mousedown', () => verOriginal(true));
botonComparar.addEventListener('mouseup', () => verOriginal(false));
botonComparar.addEventListener('mouseleave', () => verOriginal(false));

// El recorte real: pasa la proporcion elegida al procesador, que la aplica en
// el shader. Con el recuadro de guia solo se dibuja encima; con esto la imagen
// sale ya recortada hacia el lienzo, la grabacion y OBS.
//
// Sirve para sacar vertical de un movil que emite apaisado: eliges 9:16 y
// marcas la casilla. Se pierde resolucion (se recorta), pero la proporcion es
// correcta y no deforma nada.
function aplicarRecorte() {
  const activo = elRecortar.checked && elFormato.value !== 'libre';
  if (!activo) {
    procesador.recorte = 0;
  } else {
    const [a, b] = elFormato.value.split(':').map(Number);
    procesador.recorte = a / b;
  }
  dibujarGuias();
}

elFormato.addEventListener('change', aplicarRecorte);
elRecortar.addEventListener('change', aplicarRecorte);

$('rejillaBtn').addEventListener('click', () => {
  const oculta = elRejilla.classList.toggle('oculto');
  $('rejillaBtn').classList.toggle('activo', !oculta);
  dibujarGuias();
});

$('zonasBtn').addEventListener('click', () => {
  verZonas = !verZonas;
  $('zonasBtn').classList.toggle('activo', verZonas);
  dibujarGuias();
});

elEspejo.addEventListener('click', () => {
  const activo = !procesador.ajustes.espejo;
  procesador.aplicar({ espejo: activo });
  elEspejo.classList.toggle('activo', activo);
  difundirImagen();
});

elRotar.addEventListener('change', () => {
  procesador.aplicar({ rotacion: Number(elRotar.value) });
  difundirImagen();
  setTimeout(dibujarGuias, 50);
});

elDatos.addEventListener('click', () => {
  const oculto = elMedidor.classList.toggle('oculto');
  elDatos.classList.toggle('activo', !oculto);
});

elFoto.addEventListener('click', capturar);
elGrabar.addEventListener('click', () => (grabadora ? pararGrabacion() : empezarGrabacion()));

elPantalla.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else elEscena.requestFullscreen();
});

$('ocultarPanel').addEventListener('click', () => {
  const plegado = elPanel.classList.toggle('plegado');
  $('ocultarPanel').textContent = plegado ? 'Mostrar panel' : 'Ocultar panel';
  setTimeout(dibujarGuias, 60);
});

function direccionObs() {
  const p = new URLSearchParams();
  if (elFormato.value !== 'libre') p.set('formato', elFormato.value);
  const cadena = p.toString();
  return `${location.origin}/obs${cadena ? '?' + cadena : ''}`;
}

$('copiarObs').addEventListener('click', async () => {
  const boton = $('copiarObs');
  try {
    await navigator.clipboard.writeText(direccionObs());
    boton.textContent = 'Copiada ✓';
  } catch {
    boton.textContent = direccionObs();
  }
  setTimeout(() => (boton.textContent = 'Copiar direccion OBS'), 2000);
});

$('abrirObs').addEventListener('click', () => window.open(direccionObs(), '_blank'));

document.addEventListener('keydown', (e) => {
  if (['SELECT', 'INPUT'].includes(e.target.tagName)) return;
  const atajos = { f: elPantalla, s: elFoto, r: elGrabar, d: elDatos, m: elEspejo, g: $('rejillaBtn') };
  atajos[e.key]?.click();
  if (e.key === 'c' && !e.repeat) verOriginal(true);
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'c') verOriginal(false);
});

elVideo.addEventListener('loadedmetadata', () => setTimeout(dibujarGuias, 60));
elVideo.addEventListener('resize', () => setTimeout(dibujarGuias, 60));
window.addEventListener('resize', dibujarGuias);

construirPanelImagen();
cargarImagenGuardada();
refrescarPanelImagen();

// Las guias solo se rehacen cuando cambia algo que las afecte. Antes se
// redibujaban cada segundo, recreando nodos del DOM sin motivo.
let firmaGuias = '';
setInterval(() => {
  const firma = [
    elSalida.width,
    elSalida.height,
    elEscena.clientWidth,
    elEscena.clientHeight,
    elFormato.value,
    verZonas,
    elRejilla.classList.contains('oculto'),
  ].join('|');
  if (firma === firmaGuias) return;
  firmaGuias = firma;
  dibujarGuias();
}, 500);

setInterval(actualizarMedidor, 1000);
mostrarDireccion();
conectar();
