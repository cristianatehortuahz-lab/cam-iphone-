'use strict';

// Ventana limpia con la camara de Nexo, para capturarla desde TikTok LIVE Studio.
//
// Por que existe: la fuente "Enlace" de TikTok recibe el video pero no lo pinta
// (su navegador interno no decodifica el H.264 del iPhone: 150 fotogramas
// recibidos, 0 pintados, 30/09/2026), y su "Captura de ventana" no ofrece
// ventanas de Chrome. Las de Electron si aparecen, y Electron decodifica H.264.
//
// Muestra la misma pagina que la fuente de OBS (/obs), con el recorte que se
// pida. La abren Nexo Desktop (boton "Ventana TikTok" y menu de la bandeja) y
// herramientas/iniciar-directo.ps1. Es de instancia unica: abrirla otra vez solo
// la trae delante, para no tener dos decodificando lo mismo.
//
//   electron herramientas/ventana-camara [formato]     (por defecto 1:1)

const { app, BrowserWindow } = require('electron');
const path = require('path');

const formato = process.argv.find((a) => /^\d+:\d+$/.test(a)) || '1:1';
const [a, b] = formato.split(':').map(Number);
const ALTO = 720;
const ANCHO = Math.round((ALTO * a) / b);

// Carpeta de datos propia: sin ella seria la generica "Electron", compartida con
// cualquier otra app sin nombre, y el bloqueo de instancia unica las mezclaria.
app.setPath('userData', path.join(app.getPath('appData'), 'nexo-camara-tiktok'));

// Tapada por otras ventanas, Chromium dejaria de pintarla y la captura se
// congelaria.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let ventana = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!ventana || ventana.isDestroyed()) return;
    ventana.show();
    ventana.focus();
  });

  app.whenReady().then(() => {
    ventana = new BrowserWindow({
      width: ANCHO,
      height: ALTO,
      useContentSize: true,
      title: `Nexo - Camara ${formato}`,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      // Minimizada, TikTok deja de recibir imagen y se queda en negro sin
      // avisar (paso el 30/09/2026). Sin boton de minimizar, y si algo la
      // minimiza igual (Win+D, "mostrar escritorio"), se restaura sola sin
      // robar el foco.
      minimizable: false,
      webPreferences: { backgroundThrottling: false },
    });
    ventana.on('minimize', () => setTimeout(() => ventana.showInactive(), 300));
    ventana.loadURL(`http://127.0.0.1:8080/obs?formato=${encodeURIComponent(formato)}`);
    // El titulo es como TikTok la reconoce: que la pagina no lo cambie.
    ventana.on('page-title-updated', (e) => e.preventDefault());
  });

  app.on('window-all-closed', () => app.quit());
}
