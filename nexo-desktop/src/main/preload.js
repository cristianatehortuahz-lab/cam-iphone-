'use strict';

// Puente seguro entre el proceso principal y la pagina. Con contextIsolation,
// la pagina solo ve lo que exponemos aqui, nada del sistema.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexo', {
  // Estado del servidor embebido: puertos, direccion del iPhone, si hay cable.
  estado: () => ipcRenderer.invoke('nexo:estado'),
  version: process.versions.electron,
});
