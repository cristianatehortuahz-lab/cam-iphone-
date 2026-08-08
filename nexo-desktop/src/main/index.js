'use strict';

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { Ajustes } = require('./ajustes');
const { Conexion } = require('./conexion');
const { rutaLegado } = require('./clave');

// El servidor legado (auditado) corre embebido dentro de la app: sirve el
// estudio (la interfaz que carga la ventana) y mantiene la ruta por navegador
// como reserva junto al transporte nativo. En produccion se copia a
// resources/legado; en desarrollo esta en ../../../legado.

const RECURSOS = path.join(__dirname, '..', '..', 'recursos');

let ventana = null;
let bandeja = null;
let servidor = null; // referencia devuelta por legado.iniciar()
let conexion = null; // orquestador de Nexo Cam (usbmux + WiFi)
let ajustes = null;
let saliendoDeVerdad = false;

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
    ipcVideo: (v) => {
      if (ventana && !ventana.isDestroyed()) {
        ventana.webContents.send('nexo:video', v);
      }
    },
  });
  conexion.on('cambio', (c) => {
    if (ventana && !ventana.isDestroyed()) {
      ventana.webContents.send('nexo:conexion', c);
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

// El renderer manda ordenes al iPhone (cambiar de lente, zoom, etc.).
ipcMain.on('nexo:control', (_ev, orden) => conexion?.enviarControl(orden));

app.on('window-all-closed', () => {
  // En Windows, cerrar la ventana no cierra la app si vamos a la bandeja.
  if (process.platform !== 'darwin' && !ajustes.get('cerrarVaABandeja')) salir();
});

app.on('before-quit', () => {
  saliendoDeVerdad = true;
});
