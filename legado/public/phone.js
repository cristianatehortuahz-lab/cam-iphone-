'use strict';

// Pagina que corre en el iPhone: captura la camara y la envia al PC por WebRTC.
// Prioriza H.264 para que el iPhone codifique por hardware: mejor calidad, menos
// bateria y menos calor en directos largos.

const $ = (id) => document.getElementById(id);
const elVideo = $('previa');
const elLente = $('lente');
const elResolucion = $('resolucion');
const elFps = $('fps');
const elEmpezar = $('empezar');
const elParar = $('parar');
const elMicro = $('micro');
const elLinterna = $('linterna');
const elEstado = $('estado');
const elLuz = $('luz');
const elInfo = $('info');
const elCartel = $('cartel');

let ws = null;
let flujo = null;
let lentes = [];
let lenteActual = null;
let usarMicro = false;
let pistaHint = 'motion';
let bloqueoPantalla = null;
let reconectar = null;

const visores = new Set();
const conexiones = new Map();

const CONFIG_ICE = { iceServers: [], bundlePolicy: 'max-bundle' };

// Bitrate objetivo segun resolucion y fluidez. Por cable no hay razon para ser
// tacano: el cuello de botella es el encoder del iPhone, no el enlace.
function bitrateObjetivo(ancho, fps) {
  const base =
    ancho >= 3840 ? 32e6 : ancho >= 2560 ? 20e6 : ancho >= 1920 ? 12e6 : ancho >= 1280 ? 6e6 : 2.5e6;
  return Math.round(fps >= 50 ? base * 1.5 : base);
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

function marcarEstado(texto, clase) {
  elEstado.textContent = texto;
  elLuz.className = 'punto' + (clase ? ' ' + clase : '');
}

function informar(texto) {
  elInfo.textContent = texto;
}

// iOS traduce las etiquetas segun el idioma del telefono: cubrimos ambos.
// El orden importa, "ultra gran angular" tambien contiene "gran angular".
function nombreAmable(etiqueta, indice) {
  const l = (etiqueta || '').toLowerCase();
  if (!etiqueta) return `Camara ${indice + 1}`;
  if (l.includes('ultra')) return 'Ultra gran angular · 0,5x';
  if (l.includes('telefoto') || l.includes('telephoto') || l.includes('teleobj'))
    return 'Teleobjetivo';
  if (l.includes('triple')) return 'Triple camara · auto';
  if (l.includes('dual') || l.includes('doble')) return 'Doble camara · auto';
  if (l.includes('front') || l.includes('delantera')) return 'Frontal · 18 MP';
  if (
    l.includes('back') ||
    l.includes('poster') ||
    l.includes('trasera') ||
    l.includes('wide') ||
    l.includes('gran angular')
  )
    return 'Principal · 1x · 48 MP';
  return etiqueta;
}

// ---------------------------------------------------------------------------
// Senalizacion
// ---------------------------------------------------------------------------

function enviar(mensaje) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje));
}

// Lo que el iPhone puede hacer de verdad, leido del propio hardware. El PC
// dibuja sus controles a partir de esto, asi no ofrece nada que no exista.
function leerCapacidades() {
  const pista = flujo?.getVideoTracks()[0];
  if (!pista?.getCapabilities) return {};
  let cap = {};
  try {
    cap = pista.getCapabilities() || {};
  } catch {
    return {};
  }
  const ajustes = pista.getSettings ? pista.getSettings() : {};
  const salida = {};
  if (cap.zoom) salida.zoom = { ...cap.zoom, valor: ajustes.zoom ?? cap.zoom.min };
  if (cap.exposureCompensation)
    salida.exposicion = { ...cap.exposureCompensation, valor: ajustes.exposureCompensation ?? 0 };
  if (cap.focusMode) salida.modosEnfoque = cap.focusMode;
  if (cap.whiteBalanceMode) salida.modosBalance = cap.whiteBalanceMode;
  // Ojo: 'torch' in cap es cierto aunque el valor sea false. Hay que mirar el
  // contenido, que segun el navegador es un booleano o una lista de booleanos.
  salida.linterna = cap.torch === true || (Array.isArray(cap.torch) && cap.torch.includes(true));
  return salida;
}

function publicarEstado() {
  const pista = flujo?.getVideoTracks()[0];
  const s = pista?.getSettings ? pista.getSettings() : {};
  enviar({
    tipo: 'estado',
    transmitiendo: Boolean(flujo),
    lenteActual,
    micro: usarMicro,
    hint: pistaHint,
    ajustes: { ancho: s.width, alto: s.height, fps: Math.round(s.frameRate || 0) },
    capacidades: leerCapacidades(),
    lentes: lentes.map((l) => ({ id: l.deviceId, nombre: l.nombre })),
  });
}

function conectar() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    clearTimeout(reconectar);
    enviar({ tipo: 'hola', rol: 'movil' });
    marcarEstado(flujo ? 'Transmitiendo' : 'Conectado', flujo ? 'ok' : 'aviso');
  };

  ws.onclose = () => {
    marcarEstado('Servidor caido', 'error');
    for (const id of [...conexiones.keys()]) cerrarConexion(id);
    visores.clear();
    reconectar = setTimeout(conectar, 1500);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = async (evento) => {
    const msg = JSON.parse(evento.data);

    switch (msg.tipo) {
      case 'bienvenida':
        publicarEstado();
        break;

      case 'visor-listo':
        visores.add(msg.de);
        if (flujo) await abrirConexion(msg.de);
        publicarEstado();
        break;

      case 'visor-fuera':
        visores.delete(msg.de);
        cerrarConexion(msg.de);
        break;

      case 'respuesta': {
        const pc = conexiones.get(msg.de);
        if (pc) await pc.setRemoteDescription(msg.sdp);
        break;
      }

      case 'ice': {
        const pc = conexiones.get(msg.de);
        if (pc && msg.candidato) {
          try {
            await pc.addIceCandidate(msg.candidato);
          } catch {
            /* candidato tardio */
          }
        }
        break;
      }

      case 'control':
        await atenderControl(msg);
        break;
    }
  };
}

// Un valor que no este entre las opciones dejaria el <select> vacio, y de ahi
// saldrian restricciones con NaN que rompen getUserMedia. Se comprueba antes.
function opcionValida(select, valor) {
  return [...select.options].some((o) => o.value === valor);
}

async function atenderControl(msg) {
  switch (msg.accion) {
    case 'cambiar-lente':
      if (msg.valor && lentes.some((l) => l.deviceId === msg.valor)) {
        elLente.value = msg.valor;
        await abrirCamara(msg.valor);
      }
      break;

    case 'cambiar-resolucion':
      if (!opcionValida(elResolucion, msg.valor)) return;
      elResolucion.value = msg.valor;
      await abrirCamara(lenteActual);
      break;

    case 'cambiar-fps':
      if (!opcionValida(elFps, msg.valor)) return;
      elFps.value = msg.valor;
      await abrirCamara(lenteActual);
      break;

    case 'zoom':
      aplicarAvanzado({ zoom: Number(msg.valor) });
      break;

    case 'exposicion':
      aplicarAvanzado({ exposureCompensation: Number(msg.valor) });
      break;

    case 'enfoque':
      aplicarAvanzado({ focusMode: msg.valor });
      break;

    case 'balance':
      aplicarAvanzado({ whiteBalanceMode: msg.valor });
      break;

    case 'hint':
      // 'detail' conserva nitidez en planos fijos; 'motion' prioriza fluidez.
      pistaHint = msg.valor === 'detail' ? 'detail' : 'motion';
      for (const p of flujo?.getVideoTracks() || []) p.contentHint = pistaHint;
      publicarEstado();
      break;

    case 'linterna':
      alternarLinterna();
      break;

    case 'parar':
      parar();
      break;
  }
}

// Los ajustes finos de camara van en 'advanced': si el iPhone no soporta uno,
// lo ignora en vez de tirar toda la restriccion.
function aplicarAvanzado(ajuste) {
  const pista = flujo?.getVideoTracks()[0];
  if (!pista) return;
  pista
    .applyConstraints({ advanced: [ajuste] })
    .then(() => publicarEstado())
    .catch(() => informar('Esta lente no admite ese ajuste.'));
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------

// El iPhone tiene codificador H.264 por hardware. Si dejamos que WebRTC elija,
// a veces cae en VP8 por software: peor imagen, mas calor y bateria.
function preferirH264(transceptor) {
  const caps = RTCRtpSender.getCapabilities?.('video');
  if (!caps || !transceptor.setCodecPreferences) return false;
  const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
  if (!h264.length) return false;
  try {
    transceptor.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !/h264/i.test(c.mimeType))]);
    return true;
  } catch {
    return false;
  }
}

async function abrirConexion(idVisor) {
  cerrarConexion(idVisor);

  const pc = new RTCPeerConnection(CONFIG_ICE);
  conexiones.set(idVisor, pc);

  for (const pista of flujo.getTracks()) {
    const transceptor = pc.addTransceiver(pista, { direction: 'sendonly', streams: [flujo] });
    if (pista.kind === 'video') {
      preferirH264(transceptor);
      ajustarEnvio(transceptor.sender);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) enviar({ tipo: 'ice', para: idVisor, candidato: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') marcarEstado('Transmitiendo', 'ok');
    else if (['failed', 'closed'].includes(pc.connectionState)) {
      cerrarConexion(idVisor);
      if (conexiones.size === 0) marcarEstado('Sin visor', 'aviso');
    }
  };

  const oferta = await pc.createOffer();
  await pc.setLocalDescription(oferta);
  enviar({ tipo: 'oferta', para: idVisor, sdp: pc.localDescription });
}

function cerrarConexion(idVisor) {
  const pc = conexiones.get(idVisor);
  if (!pc) return;
  pc.onicecandidate = null;
  pc.onconnectionstatechange = null;
  pc.close();
  conexiones.delete(idVisor);
}

// Sin esto WebRTC se queda en ~1 Mbps y el 1080p/4K se ve blando.
function ajustarEnvio(emisor) {
  const ancho = Number(elResolucion.value.split('x')[0]);
  const fps = Number(elFps.value);

  const params = emisor.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = bitrateObjetivo(ancho, fps);
  params.encodings[0].maxFramerate = fps;
  // Ante un apuro preferimos perder nitidez antes que fluidez: en video para
  // redes, un tiron se nota mucho mas que un fotograma menos definido.
  params.degradationPreference = 'maintain-framerate';
  emisor.setParameters(params).catch(() => {
    /* Safari rechaza algunos campos segun version; no es critico */
  });
}

// ---------------------------------------------------------------------------
// Camara
// ---------------------------------------------------------------------------

async function listarLentes() {
  const dispositivos = await navigator.mediaDevices.enumerateDevices();
  lentes = dispositivos
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, nombre: nombreAmable(d.label, i), etiqueta: d.label }));

  // El iPhone expone varias entradas que caen en el mismo nombre corto (por
  // ejemplo dos modos distintos de la ultra gran angular). Sin distinguirlas,
  // el desplegable muestra opciones identicas y no sabes cual estas eligiendo.
  const vistos = new Map();
  for (const l of lentes) {
    const n = (vistos.get(l.nombre) || 0) + 1;
    vistos.set(l.nombre, n);
  }
  const contador = new Map();
  for (const l of lentes) {
    if (vistos.get(l.nombre) > 1) {
      const n = (contador.get(l.nombre) || 0) + 1;
      contador.set(l.nombre, n);
      l.nombre = `${l.nombre} (${n})`;
    }
  }

  elLente.innerHTML = '';
  for (const l of lentes) {
    const op = document.createElement('option');
    op.value = l.deviceId;
    op.textContent = l.nombre;
    elLente.appendChild(op);
  }
  elLente.disabled = lentes.length === 0;
  if (lenteActual) elLente.value = lenteActual;
}

async function abrirCamara(deviceId) {
  const [ancho, alto] = elResolucion.value.split('x').map(Number);
  const fps = Number(elFps.value);

  const restricciones = {
    video: {
      width: { ideal: ancho },
      height: { ideal: alto },
      frameRate: { ideal: fps },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
    },
    audio: usarMicro
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 }
      : false,
  };

  let nuevo;
  try {
    nuevo = await navigator.mediaDevices.getUserMedia(restricciones);
  } catch (err) {
    // Esa lente no llega a la combinacion pedida: reintentamos sin exigirla.
    if (deviceId && ['OverconstrainedError', 'NotReadableError'].includes(err.name)) {
      nuevo = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: usarMicro,
      });
      informar('Esta lente no llega a esa combinacion; usando lo maximo que permite.');
    } else {
      throw err;
    }
  }

  const anterior = flujo;
  flujo = nuevo;
  lenteActual = deviceId || nuevo.getVideoTracks()[0]?.getSettings().deviceId || null;

  for (const p of flujo.getVideoTracks()) p.contentHint = pistaHint;

  elVideo.srcObject = flujo;
  elCartel.classList.add('oculto');
  const esFrontal = /frontal/i.test(lentes.find((l) => l.deviceId === lenteActual)?.nombre || '');
  elVideo.classList.toggle('espejo', esFrontal);

  // Sustituimos la pista en las conexiones abiertas: cambiar de lente no corta
  // el directo, algo importante si estas emitiendo.
  for (const pc of conexiones.values()) {
    for (const emisor of pc.getSenders()) {
      const reemplazo = flujo.getTracks().find((t) => t.kind === emisor.track?.kind);
      if (reemplazo) {
        await emisor.replaceTrack(reemplazo).catch(() => {});
        if (reemplazo.kind === 'video') ajustarEnvio(emisor);
      }
    }
  }

  if (anterior && anterior !== flujo) for (const p of anterior.getTracks()) p.stop();

  for (const idVisor of visores) if (!conexiones.has(idVisor)) await abrirConexion(idVisor);

  await listarLentes();
  prepararLinterna();
  publicarEstado();
  mostrarAjustes();
}

function mostrarAjustes() {
  const pista = flujo?.getVideoTracks()[0];
  if (!pista) return;
  const s = pista.getSettings();
  informar(
    `${s.width}x${s.height} · ${Math.round(s.frameRate || 0)} fps · ${conexiones.size} salida(s)`
  );
}

function prepararLinterna() {
  const pista = flujo?.getVideoTracks()[0];
  let cap = {};
  try {
    cap = pista?.getCapabilities?.() || {};
  } catch {
    cap = {};
  }
  elLinterna.disabled = !(cap.torch === true || (Array.isArray(cap.torch) && cap.torch.includes(true)));
}

function alternarLinterna() {
  const pista = flujo?.getVideoTracks()[0];
  if (!pista || elLinterna.disabled) return;
  const encendida = elLinterna.classList.toggle('activo');
  pista.applyConstraints({ advanced: [{ torch: encendida }] }).catch(() => {
    elLinterna.classList.remove('activo');
    elLinterna.disabled = true;
  });
}

async function mantenerDespierto() {
  try {
    bloqueoPantalla = await navigator.wakeLock?.request('screen');
  } catch {
    /* no soportado */
  }
}

async function empezar() {
  elEmpezar.disabled = true;
  try {
    // Sin este primer permiso iOS no revela las etiquetas de las lentes.
    const previo = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const p of previo.getTracks()) p.stop();

    await listarLentes();

    const principal = lentes.find((l) => /principal/i.test(l.nombre)) || lentes[0];
    await abrirCamara(principal?.deviceId);
    await mantenerDespierto();

    elParar.disabled = false;
    elEmpezar.textContent = 'Reiniciar';
    marcarEstado(conexiones.size ? 'Transmitiendo' : 'Sin visor', conexiones.size ? 'ok' : 'aviso');
  } catch (err) {
    informar(`No se pudo abrir la camara: ${err.name}. Revisa Ajustes > Safari > Camara.`);
    marcarEstado('Error', 'error');
  } finally {
    elEmpezar.disabled = false;
  }
}

function parar() {
  for (const id of [...conexiones.keys()]) cerrarConexion(id);
  if (flujo) for (const p of flujo.getTracks()) p.stop();
  flujo = null;
  lenteActual = null;
  elVideo.srcObject = null;
  elCartel.classList.remove('oculto');
  elParar.disabled = true;
  elEmpezar.textContent = 'Empezar';
  elLinterna.disabled = true;
  elLinterna.classList.remove('activo');
  bloqueoPantalla?.release?.().catch(() => {});
  bloqueoPantalla = null;
  marcarEstado('Detenido', 'aviso');
  informar('Transmision detenida.');
  publicarEstado();
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

elEmpezar.addEventListener('click', empezar);
elParar.addEventListener('click', parar);
elLinterna.addEventListener('click', alternarLinterna);

elLente.addEventListener('change', () => {
  if (flujo) abrirCamara(elLente.value).catch((e) => informar(`Error al cambiar de lente: ${e.name}`));
});

for (const el of [elResolucion, elFps]) {
  el.addEventListener('change', () => {
    if (flujo) abrirCamara(lenteActual).catch((e) => informar(`Error al aplicar: ${e.name}`));
  });
}

elMicro.addEventListener('click', async () => {
  usarMicro = !usarMicro;
  elMicro.textContent = `Microfono: ${usarMicro ? 'si' : 'no'}`;
  elMicro.classList.toggle('activo', usarMicro);
  if (flujo) {
    // Anadir o quitar audio cambia el numero de pistas: hay que renegociar.
    await abrirCamara(lenteActual);
    for (const idVisor of visores) await abrirConexion(idVisor);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && flujo && !bloqueoPantalla) mantenerDespierto();
});

setInterval(() => {
  if (flujo) {
    mostrarAjustes();
    publicarEstado();
  }
}, 2000);

conectar();
