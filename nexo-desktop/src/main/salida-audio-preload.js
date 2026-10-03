'use strict';

// Lo minimo para la ventana oculta de salida-audio.js: recibir el audio de FL
// y contar si encontro el dispositivo.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('salida', {
  onPcm: (cb) => ipcRenderer.on('salida:pcm', (_ev, pcm) => cb(pcm)),
  estado: (e) => ipcRenderer.send('salida:estado', e),
});
