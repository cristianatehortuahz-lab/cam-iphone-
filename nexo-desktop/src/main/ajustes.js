'use strict';

// Ajustes persistentes en un JSON dentro de la carpeta de datos del usuario.
// Simple a proposito: un objeto que se lee al arrancar y se guarda al cambiar.

const fs = require('fs');
const path = require('path');

const POR_DEFECTO = {
  ventana: { ancho: 1280, alto: 800, x: null, y: null, maximizada: false },
  arranqueConWindows: false,
  minimizarABandeja: true,
  cerrarVaABandeja: true,
  modo: 'nativo', // 'nativo' (embebido) | 'navegador' (solo servidor + navegador externo)
  // Audio de FL hacia un dispositivo de Windows (TikTok LIVE Studio). Solo suena
  // si ese dispositivo existe: ver salida-audio.js.
  salidaAudioFL: { activa: true, dispositivo: 'CABLE Input' },
  // La camara como webcam de Windows ("OBS Virtual Camera"): ver camara-virtual.js.
  // giro: 0, 90, 180 o 270. encuadre: null (completo), '1:1', '9:16', '4:5' o '16:9'.
  camaraVirtual: { activa: true, giro: 0, espejo: false, encuadre: null },
  // El micro del iPhone mezclado en el audio del directo (micro-iphone.js).
  // Apagado por defecto: tambien recoge la voz sin Auto-Tune. nivel en %.
  microIphone: { activo: false, nivel: 100 },
};

class Ajustes {
  constructor(directorioDatos) {
    this.archivo = path.join(directorioDatos, 'ajustes.json');
    this.datos = { ...POR_DEFECTO };
    this.cargar();
  }

  cargar() {
    try {
      // Sin la marca BOM: PowerShell la pone al guardar, JSON.parse no la traga y
      // se perdian todos los ajustes sin avisar (paso el 05/10/2026).
      const guardado = JSON.parse(fs.readFileSync(this.archivo, 'utf8').replace(/^﻿/, ''));
      // Mezcla superficial: preserva claves nuevas que el usuario no tenga.
      this.datos = { ...POR_DEFECTO, ...guardado, ventana: { ...POR_DEFECTO.ventana, ...(guardado.ventana || {}) } };
    } catch {
      /* primera vez o archivo corrupto: valores por defecto */
    }
  }

  guardar() {
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
      fs.writeFileSync(this.archivo, JSON.stringify(this.datos, null, 2));
    } catch (e) {
      console.error('No se pudieron guardar los ajustes:', e.message);
    }
  }

  get(clave) {
    return this.datos[clave];
  }

  set(clave, valor) {
    this.datos[clave] = valor;
    this.guardar();
  }
}

module.exports = { Ajustes };
