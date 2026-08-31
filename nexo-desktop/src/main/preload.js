'use strict';

// Puente seguro entre el proceso principal y la pagina. Con contextIsolation,
// la pagina solo ve lo que exponemos aqui, nada del sistema.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexo', {
  // Estado del servidor embebido: puertos, direccion del iPhone, si hay cable.
  estado: () => ipcRenderer.invoke('nexo:estado'),
  version: process.versions.electron,

  // Conexion nativa con Nexo Cam (F3.5).
  // Los buffers de video llegan como { microsegundos, clave, datos } donde
  // datos es un Buffer (Electron lo convierte a Uint8Array-compatible via IPC).
  onVideo: (cb) => ipcRenderer.on('nexo:video', (_ev, v) => cb(v)),
  // Audio AAC en ADTS, cada paquete con su cabecera: se puede decodificar sin
  // configuracion previa.
  onAudio: (cb) => ipcRenderer.on('nexo:audio', (_ev, a) => cb(a)),
  onConexion: (cb) => ipcRenderer.on('nexo:conexion', (_ev, c) => cb(c)),
  enviarControl: (orden) => ipcRenderer.send('nexo:control', orden),
});
