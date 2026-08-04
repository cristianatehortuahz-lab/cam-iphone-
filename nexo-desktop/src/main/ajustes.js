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
};

class Ajustes {
  constructor(directorioDatos) {
    this.archivo = path.join(directorioDatos, 'ajustes.json');
    this.datos = { ...POR_DEFECTO };
    this.cargar();
  }

  cargar() {
    try {
      const guardado = JSON.parse(fs.readFileSync(this.archivo, 'utf8'));
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
