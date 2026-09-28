'use strict';

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { Ajustes } = require('./ajustes');
const { Conexion } = require('./conexion');
const protocolo = require('./protocolo');
const { Grabador } = require('./grabador');
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
    servidor = await legado.iniciar({ silencioso: true });
    console.log('[nexo] servidor legado en', servidor.puertos, 'cable:', servidor.hayCable);
  } catch (err) {
    // Si el puerto esta ocupado o falla, la app sigue abriendo y lo muestra;
    // no tiene sentido cerrar toda la app por esto.
    console.error('[nexo] no se pudo iniciar el servidor:', err.mensajeUsuario || err.message);
    servidor = null;
  }
}

// --- Conexion nativa con Nexo Cam ------------------------------------------

async function iniciarConexionNativa() {
  conexion = new Conexion({
    // Cada fotograma llega ya con u64 tiempo, u8 flags (clave) y las NAL.
    // Se reenvia al renderer, que lo mete en el decodificador WebCodecs.
    ipcAudio: (a, id) => {
      if (id !== conexion.principal) return; // solo se oye la camara principal
      if (ventana && !ventana.isDestroyed()) {
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

function crearVentana() {
  const v = ajustes.get('ventana');

  ventana = new BrowserWindow({
    width: v.ancho,
    height: v.alto,
    x: v.x ?? undefined,
    y: v.y ?? undefined,
    minWidth: 940,
    minHeight: 620,
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
    }
  });
}

function guardarTamanoAlCambiar() {
  let temporizador = null;
  const guardar = () => {
    if (!ventana || ventana.isDestroyed()) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      const maximizada = ventana.isMaximized();
      const b = ventana.getBounds();
      const actual = ajustes.get('ventana');
      ajustes.set('ventana', {
        ...actual,
        maximizada,
        // Solo guardamos el tamano "normal", no el de maximizada.
        ...(maximizada ? {} : { ancho: b.width, alto: b.height, x: b.x, y: b.y }),
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
