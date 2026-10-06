'use strict';

// Un microfono de Windows, para llevarselo al DAW.
//
// Sirve para un segundo micro enchufado a OTRA interfaz de audio (la M-Track
// Solo, con la AIR 192|4 como principal). El DAW solo admite un driver ASIO, y
// juntar las dos interfaces con ASIO4ALL metia ruido en la voz (ver el
// comentario de puente-audio.js). Aqui el micro se coge por Windows, con el
// driver del fabricante, y el puente se lo manda al DAW por ReaStream.
//
// Captura una ventana oculta porque es Chromium quien sabe abrir un microfono
// por su nombre sin modulos nativos, igual que salida-audio.js con la salida.
// Apagado por defecto: sin dispositivo configurado no se crea ni la ventana.

const { BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');

class MicroWindows extends EventEmitter {
  constructor({ dispositivo = '', canal = 0 } = {}) {
    super();
    this.dispositivo = dispositivo;
    this.canal = canal;
    this.ventana = null;
    this.encontrado = false;
    this.etiqueta = null;
    this.error = null;
    this.ultimo = 0; // cuando llego audio por ultima vez
    this.pico = 0;   // nivel maximo desde el ultimo informe
    this.alEstado = (ev, e) => {
      if (!this.ventana || ev.sender !== this.ventana.webContents) return;
      this.encontrado = Boolean(e && e.encontrado);
      this.etiqueta = (e && e.etiqueta) || null;
      this.error = (e && e.error) || null;
      this.emit('estado', this.estado());
    };
    this.alPcm = (ev, fs, pcm) => {
      if (!this.ventana || ev.sender !== this.ventana.webContents) return;
      if (!(pcm instanceof Float32Array) || !pcm.length) return;
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.abs(pcm[i]);
        if (v > this.pico) this.pico = v;
      }
      this.ultimo = Date.now();
      this.emit('pcm', Number(fs) || 44100, pcm);
    };
  }

  estado() {
    return {
      activo: Boolean(this.ventana),
      encontrado: this.encontrado,
      dispositivo: this.etiqueta,
      llega: Boolean(this.ventana) && Date.now() - this.ultimo < 1000,
      error: this.error,
    };
  }

  iniciar() {
    if (this.ventana || !this.dispositivo) return;
    // Sesion propia: el permiso de microfono no se abre al estudio.
    const ses = session.fromPartition('nexo-micro-windows');
    ses.setPermissionCheckHandler((_wc, permiso) => permiso === 'media');
    ses.setPermissionRequestHandler((_wc, permiso, responder) => responder(permiso === 'media'));

    ipcMain.on('micro-win:estado', this.alEstado);
    ipcMain.on('micro-win:pcm', this.alPcm);
    this.ventana = new BrowserWindow({
      show: false,
      width: 320,
      height: 120,
      skipTaskbar: true,
      webPreferences: {
        session: ses,
        preload: path.join(__dirname, 'micro-windows-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Oculta, Chromium la frenaria: el audio llegaria a trompicones.
        backgroundThrottling: false,
      },
    });
    this.ventana.loadFile(path.join(__dirname, '..', 'render', 'micro-windows.html'), {
      query: { dispositivo: this.dispositivo, canal: String(this.canal) },
    });
  }

  // Nivel maximo (0..1) desde la ultima llamada. Para el registro.
  leerPico() {
    const p = this.pico;
    this.pico = 0;
    return p;
  }

  detener() {
    ipcMain.removeListener('micro-win:estado', this.alEstado);
    ipcMain.removeListener('micro-win:pcm', this.alPcm);
    if (this.ventana && !this.ventana.isDestroyed()) this.ventana.destroy();
    this.ventana = null;
    this.encontrado = false;
  }
}

module.exports = { MicroWindows };
