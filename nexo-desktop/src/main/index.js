'use strict';

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { Ajustes } = require('./ajustes');
const { Conexion } = require('./conexion');
const protocolo = require('./protocolo');
const { Grabador } = require('./grabador');
const { PuenteAudio } = require('./puente-audio');
const { SalidaAudio } = require('./salida-audio');
const { rutaLegado } = require('./clave');

// El servidor legado (auditado) corre embebido dentro de la app: sirve el
// estudio (la interfaz que carga la ventana) y mantiene la ruta por navegador
// como reserva junto al transporte nativo. En produccion se copia a
// resources/legado; en desarrollo esta en ../../../legado.

const RECURSOS = path.join(__dirname, '..', '..', 'recursos');

// Hora en cada linea del registro. Sin ella no habia forma de cruzar un corte
// de sesion o una orden al movil con un salto en el video.
for (const nivel of ['log', 'warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => original(new Date().toISOString().slice(11, 23), ...args);
}

let ventana = null;
let bandeja = null;
let servidor = null; // referencia devuelta por legado.iniciar()
let conexion = null; // orquestador de Nexo Cam (usbmux + WiFi)
let ajustes = null;
let puenteAudio = null; // FL Studio -> OBS por ReaStream (ver puente-audio.js)
let salidaAudio = null; // FL Studio -> VB-Cable -> TikTok LIVE Studio (ver salida-audio.js)
let salidaAudioEstado = { encontrado: false, etiqueta: null };
const grabador = new Grabador();
let saliendoDeVerdad = false;

// Mientras la ventana esta oculta no se le manda video (ahorra una decodificacion
// 4K entera). Al reaparecer hay que esperar a un fotograma clave para reenganchar
// sin pintar basura.
let estudioEsperandoClave = false;

// Una sola instancia: el segundo arranque solo enfoca la ventana existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mostrarVentana());
  arrancar();
}

async function arrancar() {
  await app.whenReady();
  ajustes = new Ajustes(app.getPath('userData'));

  await iniciarServidor();
  await iniciarConexionNativa();
  await iniciarPuenteAudio();
  crearVentana();
  crearBandeja();
  aplicarArranqueConWindows();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
}

// --- Servidor embebido ------------------------------------------------------

async function iniciarServidor() {
  try {
    const legado = require(rutaLegado('server.js'));
    servidor = await legado.iniciar({ silencioso: true, estadoNexo });
    console.log('[nexo] servidor legado en', servidor.puertos, 'cable:', servidor.hayCable);
  } catch (err) {
    // Si el puerto esta ocupado o falla, la app sigue abriendo y lo muestra;
    // no tiene sentido cerrar toda la app por esto.
    console.error('[nexo] no se pudo iniciar el servidor:', err.mensajeUsuario || err.message);
    servidor = null;
  }
}

// Lo que consulta herramientas/iniciar-directo.ps1 (por /api/nexo) para dar el
// visto bueno antes de un directo. Solo lectura.
function estadoNexo() {
  const e = conexion ? conexion.estado() : null;
  const movil = (e && e.estadoMovil) || {};
  return {
    iphone: {
      conectado: Boolean(e && e.conectado),
      origen: (e && e.origen) || null,
      hayCable: Boolean(e && e.hayCable),
      // Atiende las ordenes del estudio. Puede ser falso con el video llegando.
      responde: Boolean(e && e.conectado && e.responde),
      transmitiendo: Boolean(movil.transmitiendo),
      resolucion: movil.resolucion || null,
      resolucionReal: movil.resolucionReal || null,
      fps: movil.fps || null,
    },
    audioFL: { puente: Boolean(puenteAudio), llega: audioFLLlega },
    salidaTikTok: { activa: salidaAudioEstado.encontrado, dispositivo: salidaAudioEstado.etiqueta },
    grabando: grabador.grabando,
  };
}

// --- Audio de FL Studio hacia OBS -------------------------------------------

let audioFLLlega = false;

async function iniciarPuenteAudio() {
  puenteAudio = new PuenteAudio();
  puenteAudio.on('estado', (llega) => {
    audioFLLlega = llega;
    console.log(llega ? '[audio] llega FL por ReaStream' : '[audio] FL dejo de enviar');
  });
  puenteAudio.on('error', (e) => console.error('[audio] puente:', e.message));
  try {
    await puenteAudio.iniciar();
    console.log('[audio] puente ReaStream listo');
  } catch (e) {
    // Sin puente, OBS sigue recibiendo si se abrio antes que FL.
    console.error('[audio] no se pudo abrir el puente ReaStream:', e.message);
    puenteAudio = null;
    return;
  }
  iniciarSalidaAudio();
}

// El mismo audio de FL, reproducido en VB-Cable para TikTok LIVE Studio. El
// puente solo desmonta los paquetes mientras el cable existe.
function iniciarSalidaAudio() {
  const conf = ajustes.get('salidaAudioFL');
  if (!conf || !conf.activa) return;
  salidaAudio = new SalidaAudio({ dispositivo: conf.dispositivo });
  let primera = true;
  salidaAudio.on('estado', (e) => {
    const antes = salidaAudioEstado;
    salidaAudioEstado = { encontrado: Boolean(e.encontrado), etiqueta: e.etiqueta || null };
    if (e.error) console.error('[audio] salida a', conf.dispositivo + ':', e.error);
    if (!primera && antes.encontrado === salidaAudioEstado.encontrado) return;
    primera = false;
    puenteAudio.activarSalida(salidaAudioEstado.encontrado);
    console.log(
      salidaAudioEstado.encontrado
        ? `[audio] FL sale tambien por ${salidaAudioEstado.etiqueta}`
        : `[audio] no hay "${conf.dispositivo}": FL no sale por ningun dispositivo extra`
    );
  });
  puenteAudio.on('pcm', (pcm) => salidaAudio.enviar(pcm));
  salidaAudio.iniciar();
}

// --- Conexion nativa con Nexo Cam ------------------------------------------

async function iniciarConexionNativa() {
  conexion = new Conexion({
    // Cada fotograma llega ya con u64 tiempo, u8 flags (clave) y las NAL.
    // Se reenvia al renderer, que lo mete en el decodificador WebCodecs.
    ipcAudio: (a, id) => {
      if (id !== conexion.principal) return; // solo se oye la camara principal
      // Como el video: solo con el estudio a la vista. Oculto, decodificar el
      // audio del iPhone no sirve a nadie (la grabacion va por el proceso
      // principal) y su renderer seguia gastando ~14 % de CPU en la bandeja
      // (medido el 30/09/2026 con OBS y TikTok abiertos, el PC al limite).
      if (ventana && !ventana.isDestroyed() && ventana.isVisible() && !ventana.isMinimized()) {
        ventana.webContents.send('nexo:audio', a);
      }
    },
    ipcVideo: (v, id) => {
      // El grabador se queda con TODAS las camaras: se graban todos los angulos
      // aunque en pantalla solo se vea uno.
      grabador.escribir(v, id);

      // De aqui en adelante, solo la principal: es la que se ve y la que sale a
      // OBS. Mandar las demas seria gastar IPC y ancho de banda para nada.
      if (id !== conexion.principal) return;

      // El flag que manda el movil se queda corto: hay IDR que llegan marcadas
      // como delta. Lo confirmamos con el bitstream una sola vez aqui, y ese
      // valor ya sirve para todo lo de abajo y viaja en la carga hacia OBS.
      const clave = v.clave || protocolo.esFotogramaClave(v.datos);

      // Al estudio solo si la ventana esta a la vista. Con la fuente de OBS
      // abierta, el mismo 4K se decodificaba dos veces en paralelo (aqui y en
      // el CEF de OBS) mas dos pipelines WebGL; en una GPU integrada eso no
      // cabe y la imagen llegaba a OBS a pocos fotogramas por segundo.
      // Minimizado a la bandeja, el estudio no gasta nada.
      const verEstudio =
        ventana && !ventana.isDestroyed() && ventana.isVisible() && !ventana.isMinimized();

      if (!verEstudio) {
        estudioEsperandoClave = true;
      } else {
        // Al volver de la bandeja hay que reenganchar en una clave: entrar a
        // mitad de GOP deja al decodificador pintando bloques corruptos hasta
        // la siguiente IDR, que puede tardar dos segundos.
        if (estudioEsperandoClave && clave) estudioEsperandoClave = false;
        if (!estudioEsperandoClave) ventana.webContents.send('nexo:video', v);
      }

      // Y a los navegadores que lo pidan (la fuente de OBS). Por cable el
      // iPhone no participa en la senalizacion WebRTC, asi que sin esto la
      // salida a OBS se queda en negro con el estudio recibiendo imagen.
      if (servidor && servidor.difundirVideo) {
        servidor.difundirVideo(
          protocolo.codificarCargaMedia(v.microsegundos, v.datos, { clave })
        );
      }
    },
  });
  conexion.on('cambio', (c) => {
    if (ventana && !ventana.isDestroyed()) {
      ventana.webContents.send('nexo:conexion', c);
    }
    // La fuente de OBS vive en un navegador aparte y no ve el IPC: si la sesion
    // por cable se cierra, hay que decirselo para que reinicie su decodificador.
    if (c.evento === 'sesion-cerrada' && servidor && servidor.avisarVisores) {
      servidor.avisarVisores({ tipo: 'nexo-sin-sesion' });
    }

    // Refrescar el menu de bandeja si cambia el estado importante.
    if (['sesion-abierta', 'sesion-cerrada', 'cable-detectado', 'cable-quitado'].includes(c.evento)) {
      if (bandeja) refrescarMenuBandeja();
    }
  });
  try {
    await conexion.iniciar();
    console.log('[nexo] orquestador de conexion arrancado');
  } catch (e) {
    console.error('[nexo] no se pudo arrancar la conexion nativa:', e.message);
  }
}

// --- Ventana principal ------------------------------------------------------

const MIN_ANCHO = 940;
const MIN_ALTO = 620;
const ANCHO_INICIAL = 1280;
const ALTO_INICIAL = 800;

// El tamano guardado encoge solo. Con dos pantallas a distinta escala (portatil
// al 125 %, monitor externo al 100 %), Electron devuelve el tamano de la ventana
// del monitor externo dividido por 1,25: se abrio a 1280x800 y guardo 1024x640
// (medido el 28/09/2026). Cada apertura la dejaba un 20 % mas pequena hasta el
// minimo, y asi aparecio el 753x497 que la abria en miniatura. Por eso el
// tamano guardado nunca baja del inicial. Y una posicion en un monitor que ya
// no esta la abriria fuera de la vista.
function limitesGuardados(v) {
  const { screen } = require('electron');
  const limites = {
    width: Math.max(v.ancho || 0, ANCHO_INICIAL),
    height: Math.max(v.alto || 0, ALTO_INICIAL),
  };
  // La posicion se conserva aunque el tamano no valga: dice en que monitor
  // trabaja el usuario, y maximizada tiene que abrirse en ese.
  if (v.x != null && v.y != null) {
    const r = { x: v.x, y: v.y, width: limites.width, height: limites.height };
    const area = screen.getDisplayMatching(r).workArea;
    const visible =
      r.x < area.x + area.width && r.x + r.width > area.x &&
      r.y < area.y + area.height && r.y + r.height > area.y;
    if (visible) Object.assign(limites, { x: v.x, y: v.y });
  }
  return limites;
}

function crearVentana() {
  const v = ajustes.get('ventana');

  ventana = new BrowserWindow({
    ...limitesGuardados(v),
    minWidth: MIN_ANCHO,
    minHeight: MIN_ALTO,
    backgroundColor: '#0b0d10',
    show: false,
    icon: path.join(RECURSOS, 'icono.ico'),
    // Barra de titulo propia: controles nativos de Windows sobre una franja del
    // color de la marca. Sin dibujar botones a mano.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#14181e', symbolColor: '#e6ebf2', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (v.maximizada) ventana.maximize();

  // De momento el estudio es el del servidor embebido. Si no arranco, mostramos
  // una pagina de estado local.
  if (servidor) {
    ventana.loadURL(`http://localhost:${servidor.puertos.http}`);
  } else {
    ventana.loadFile(path.join(__dirname, '..', 'render', 'sin-servidor.html'));
  }

  ventana.once('ready-to-show', () => ventana.show());

  // Inyecta una franja arrastrable bajo los controles nativos, para poder mover
  // la ventana desde la cabecera del estudio (que sirve el servidor legado).
  ventana.webContents.on('did-finish-load', () => {
    ventana.webContents.insertCSS(
      `html::before{content:'';position:fixed;top:0;left:0;right:140px;height:40px;
       -webkit-app-region:drag;z-index:2147483647;pointer-events:none}`
    );
  });

  // Los enlaces externos (por ejemplo el certificado) van al navegador del
  // sistema, no abren ventanas de Electron.
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  guardarTamanoAlCambiar();

  ventana.on('close', (e) => {
    if (!saliendoDeVerdad && ajustes.get('cerrarVaABandeja')) {
      e.preventDefault();
      ventana.hide();
    } else if (!saliendoDeVerdad) {
      // La ventana oculta del audio (salida-audio.js) tambien cuenta: sin esto
      // 'window-all-closed' no llegaria nunca y la app seguiria viva sin ventana.
      e.preventDefault();
      salir();
    }
  });
}

function guardarTamanoAlCambiar() {
  let temporizador = null;
  const guardar = () => {
    if (!ventana || ventana.isDestroyed()) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      if (ventana.isDestroyed()) return;
      // Minimizada u oculta en la bandeja, Windows da medidas que no son las de
      // la ventana: guardarlas es como acababa abriendose en miniatura.
      if (ventana.isMinimized() || !ventana.isVisible()) return;
      const maximizada = ventana.isMaximized();
      // getNormalBounds: el tamano "normal" aunque ahora este maximizada.
      const b = ventana.getNormalBounds();
      const actual = ajustes.get('ventana');
      ajustes.set('ventana', {
        ...actual,
        maximizada,
        ...(b.width >= MIN_ANCHO && b.height >= MIN_ALTO
          ? { ancho: b.width, alto: b.height, x: b.x, y: b.y }
          : {}),
      });
    }, 400);
  };
  ventana.on('resize', guardar);
  ventana.on('move', guardar);
  ventana.on('maximize', guardar);
  ventana.on('unmaximize', guardar);
}

function mostrarVentana() {
  if (!ventana || ventana.isDestroyed()) return crearVentana();
  if (ventana.isMinimized()) ventana.restore();
  ventana.show();
  ventana.focus();
}

// --- Bandeja ----------------------------------------------------------------

function crearBandeja() {
  const icono = nativeImage.createFromPath(path.join(RECURSOS, 'bandeja.png'));
  bandeja = new Tray(icono);
  bandeja.setToolTip('Nexo — Camara Pro');
  refrescarMenuBandeja();
  bandeja.on('double-click', mostrarVentana);
}

function refrescarMenuBandeja() {
  const est = conexion?.estado();
  let estado;
  if (est?.conectado) {
    estado = `iPhone conectado (${est.origen})`;
  } else if (est?.hayCable) {
    estado = 'iPhone enchufado, esperando la app';
  } else {
    estado = servidor ? 'Sin iPhone' : 'Servidor no iniciado';
  }

  const menu = Menu.buildFromTemplate([
    { label: estado, enabled: false },
    { type: 'separator' },
    { label: 'Abrir el estudio', click: mostrarVentana },
    { label: 'Abrir ventana de camara para TikTok', enabled: Boolean(servidor), click: abrirVentanaTikTok },
    {
      label: 'Copiar direccion del iPhone',
      enabled: Boolean(servidor),
      click: () => {
        if (servidor) require('electron').clipboard.writeText(servidor.destino);
      },
    },
    { type: 'separator' },
    {
      label: 'Arrancar Nexo con Windows',
      type: 'checkbox',
      checked: ajustes.get('arranqueConWindows'),
      click: (item) => {
        ajustes.set('arranqueConWindows', item.checked);
        aplicarArranqueConWindows();
      },
    },
    {
      label: 'Cerrar minimiza a la bandeja',
      type: 'checkbox',
      checked: ajustes.get('cerrarVaABandeja'),
      click: (item) => ajustes.set('cerrarVaABandeja', item.checked),
    },
    { type: 'separator' },
    { label: 'Salir de Nexo', click: salir },
  ]);
  bandeja.setContextMenu(menu);
}

// --- Ventana de la camara para TikTok ---------------------------------------

// TikTok LIVE Studio captura esta ventana (herramientas/ventana-camara). Es de
// instancia unica: si ya esta abierta, la segunda llamada solo la trae delante.
// Va como proceso aparte, con sus propias opciones de Chromium para pintar aunque
// este tapada, que aqui afectarian tambien al estudio.
//
// En la version empaquetada (instalador) habra que llevar la ventana dentro de
// la app: process.execPath sera Nexo.exe y no un electron.exe que ejecute scripts.
function abrirVentanaTikTok() {
  const script = path.join(__dirname, '..', '..', '..', 'herramientas', 'ventana-camara', 'main.js');
  if (!require('fs').existsSync(script)) {
    console.error('[nexo] no encuentro la ventana de camara:', script);
    return false;
  }
  const { spawn } = require('child_process');
  spawn(process.execPath, [script, '1:1'], { detached: true, stdio: 'ignore' }).unref();
  console.log('[nexo] ventana de camara para TikTok');
  return true;
}

ipcMain.handle('nexo:ventana-tiktok', () => abrirVentanaTikTok());

// --- Arranque con Windows ---------------------------------------------------

function aplicarArranqueConWindows() {
  app.setLoginItemSettings({
    openAtLogin: ajustes.get('arranqueConWindows'),
    args: ['--oculto'], // arranca minimizado en la bandeja
  });
}

// --- Salida ordenada --------------------------------------------------------

async function salir() {
  saliendoDeVerdad = true;
  try {
    // Cerrar la toma antes que nada: asi el contenedor se cierra bien en vez
    // de quedar a medias.
    if (grabador.grabando) await grabador.parar(conexion?.camaras() || []);
    if (conexion) await conexion.detener();
    if (servidor) await servidor.detener();
    if (salidaAudio) salidaAudio.detener();
    if (puenteAudio) puenteAudio.detener();
  } catch {
    /* da igual: estamos saliendo */
  }
  app.quit();
}

ipcMain.handle('nexo:estado', () => ({
  servidor: Boolean(servidor),
  puertos: servidor?.puertos || null,
  destino: servidor?.destino || null,
  clave: servidor?.clave || null,
  hayCable: servidor?.hayCable || false,
  conexion: conexion?.estado() || null,
}));

// El renderer manda ordenes al iPhone (cambiar de lente, zoom, etc.). Sin id
// van a todas las camaras a la vez.
ipcMain.on('nexo:control', (_ev, orden, id) => {
  // Queda en el registro: cambiar resolucion, fps o lente reconfigura la camara
  // del movil y congela la imagen un momento, y una orden repetida no se veia.
  console.log('[nexo] orden al movil:', JSON.stringify(orden));
  conexion?.enviarControl(orden, id);
});

// Cual se ve en el estudio. Grabar sigue grabandolas todas.
// Desbloquear: corta las sesiones y deja que el sondeo las reabra. Devuelve
// cuantas se cortaron para poder decirselo al usuario, que si no no sabe si el
// boton hizo algo.
ipcMain.handle('nexo:reiniciar', () => ({ ok: true, cuantas: conexion?.reiniciar() ?? 0 }));

ipcMain.handle('nexo:principal', (_ev, id) => conexion?.elegirPrincipal(id) || false);

// --- Grabacion --------------------------------------------------------------

function carpetaGrabaciones() {
  return ajustes.get('carpetaGrabaciones') || path.join(app.getPath('videos'), 'Nexo');
}

ipcMain.handle('nexo:grabar', () => {
  const r = grabador.empezar(conexion?.camaras() || [], carpetaGrabaciones());
  if (ventana && !ventana.isDestroyed()) {
    ventana.webContents.send('nexo:grabacion', grabador.estado());
  }
  return r;
});

ipcMain.handle('nexo:parar-grabacion', async () => {
  const r = await grabador.parar(conexion?.camaras() || []);
  if (ventana && !ventana.isDestroyed()) {
    ventana.webContents.send('nexo:grabacion', grabador.estado());
  }
  return r;
});

ipcMain.handle('nexo:estado-grabacion', () => grabador.estado());

ipcMain.handle('nexo:elegir-carpeta', async () => {
  const r = await dialog.showOpenDialog(ventana, {
    title: 'Donde guardar las grabaciones',
    defaultPath: carpetaGrabaciones(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  ajustes.set('carpetaGrabaciones', r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('nexo:abrir-carpeta', (_ev, ruta) => {
  shell.openPath(ruta || carpetaGrabaciones());
});

app.on('window-all-closed', () => {
  // En Windows, cerrar la ventana no cierra la app si vamos a la bandeja.
  if (process.platform !== 'darwin' && !ajustes.get('cerrarVaABandeja')) salir();
});

app.on('before-quit', () => {
  saliendoDeVerdad = true;
});
