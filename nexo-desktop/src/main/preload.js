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
  // Sin id, la orden va a todas las camaras a la vez.
  enviarControl: (orden, id) => ipcRenderer.send('nexo:control', orden, id),
  elegirPrincipal: (id) => ipcRenderer.invoke('nexo:principal', id),
  // Desbloquea la conexion sin cerrar la aplicacion.
  reiniciar: () => ipcRenderer.invoke('nexo:reiniciar'),

  // Grabacion. Vive en el proceso principal: escribe a disco sin recodificar y
  // sigue aunque la ventana este minimizada.
  grabar: () => ipcRenderer.invoke('nexo:grabar'),
  pararGrabacion: () => ipcRenderer.invoke('nexo:parar-grabacion'),
  estadoGrabacion: () => ipcRenderer.invoke('nexo:estado-grabacion'),
  onGrabacion: (cb) => ipcRenderer.on('nexo:grabacion', (_ev, g) => cb(g)),
  elegirCarpeta: () => ipcRenderer.invoke('nexo:elegir-carpeta'),
  abrirCarpeta: (ruta) => ipcRenderer.invoke('nexo:abrir-carpeta', ruta),
});
