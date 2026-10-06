'use strict';

// Lo minimo para la ventana oculta de micro-windows.js: entregar el audio del
// microfono y contar si encontro el dispositivo.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('micro', {
  pcm: (fs, pcm) => ipcRenderer.send('micro-win:pcm', fs, pcm),
  estado: (e) => ipcRenderer.send('micro-win:estado', e),
});
