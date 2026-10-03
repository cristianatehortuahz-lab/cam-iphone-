'use strict';

// Reproduce el audio de FL Studio en un dispositivo de Windows para que otra
// aplicacion lo coja como microfono. Es para TikTok LIVE Studio: no sabe
// recibir ReaStream, y FL sale por ASIO, que no pasa por Windows, asi que no
// hay nada que capturar. Con VB-Cable, Nexo reproduce en "CABLE Input" y TikTok
// usa "CABLE Output" como micro.
//
// El audio es el que ya recibe el puente ReaStream (puente-audio.js): el Master
// de FL con el Auto-Tune y el beat, igual que le llega a OBS.
//
// Nunca cae al dispositivo por defecto. Si el cable no esta, se calla: sonar
// por los auriculares seria el audio de FL por segunda vez y con retraso, y por
// los altavoces volveria a entrar por el micro.
//
// Reproduce una ventana oculta porque es Chromium quien sabe elegir el
// dispositivo de salida (setSinkId) sin modulos nativos.

const { BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');

class SalidaAudio extends EventEmitter {
  constructor({ dispositivo = 'CABLE Input' } = {}) {
    super();
    this.dispositivo = dispositivo;
    this.ventana = null;
    this.lista = false;
    this.alEstado = (ev, e) => {
      if (!this.ventana || ev.sender !== this.ventana.webContents) return;
      this.lista = Boolean(e && e.encontrado);
      this.emit('estado', e);
    };
  }

  iniciar() {
    // Sesion propia: los permisos de audio que necesita esta ventana (ver los
    // nombres de los dispositivos y elegir la salida) no se abren al estudio.
    const ses = session.fromPartition('nexo-salida-audio');
    const permitido = (permiso) => permiso === 'media' || permiso === 'speaker-selection';
    ses.setPermissionCheckHandler((_wc, permiso) => permitido(permiso));
    ses.setPermissionRequestHandler((_wc, permiso, responder) => responder(permitido(permiso)));

    ipcMain.on('salida:estado', this.alEstado);
    this.ventana = new BrowserWindow({
      show: false,
      width: 320,
      height: 120,
      skipTaskbar: true,
      webPreferences: {
        session: ses,
        preload: path.join(__dirname, 'salida-audio-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Oculta, Chromium la frenaria: el audio iria a trompicones.
        backgroundThrottling: false,
      },
    });
    this.ventana.loadFile(path.join(__dirname, '..', 'render', 'salida-audio.html'), {
      query: { dispositivo: this.dispositivo },
    });
  }

  enviar(pcm) {
    if (!this.lista || !this.ventana || this.ventana.isDestroyed()) return;
    this.ventana.webContents.send('salida:pcm', pcm);
  }

  detener() {
    ipcMain.removeListener('salida:estado', this.alEstado);
    if (this.ventana && !this.ventana.isDestroyed()) this.ventana.destroy();
    this.ventana = null;
    this.lista = false;
  }
}

module.exports = { SalidaAudio };
