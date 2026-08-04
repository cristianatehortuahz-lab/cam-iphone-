'use strict';

// Descubrimiento por WiFi con Bonjour (mDNS). El PC se anuncia en la red local
// como servicio "_nexo._tcp"; la app del iPhone lo encuentra en una lista y se
// conecta sin que nadie teclee una direccion IP. Es la ruta alternativa al
// cable: mismo protocolo por encima, distinto camino.

const os = require('os');
const { Bonjour } = require('bonjour-service');

const TIPO = 'nexo';

class Anunciante {
  constructor() {
    this.bonjour = new Bonjour();
    this.servicio = null;
  }

  // Publica el PC como receptor Nexo en el puerto del transporte WiFi.
  anunciar(puerto) {
    this.detener();
    this.servicio = this.bonjour.publish({
      name: `Nexo en ${os.hostname()}`,
      type: TIPO,
      port: puerto,
      txt: { version: '1', app: 'Nexo Desktop', equipo: os.hostname() },
    });
    return this.servicio;
  }

  detener() {
    if (this.servicio) {
      try {
        this.servicio.stop();
      } catch {
        /* ya detenido */
      }
      this.servicio = null;
    }
  }

  cerrar() {
    this.detener();
    try {
      this.bonjour.destroy();
    } catch {
      /* ya cerrado */
    }
  }
}

// Busca otros PCs con Nexo en la red (util para pruebas y para la app iOS, que
// hace lo mismo desde Swift). onCambio recibe la lista actual.
class Buscador {
  constructor(onCambio) {
    this.bonjour = new Bonjour();
    this.onCambio = onCambio || (() => {});
    this.encontrados = new Map();
    this.navegador = null;
  }

  iniciar() {
    this.navegador = this.bonjour.find({ type: TIPO }, () => {});
    const emitir = () => this.onCambio([...this.encontrados.values()]);

    this.navegador.on('up', (s) => {
      this.encontrados.set(s.fqdn || s.name, {
        nombre: s.name,
        puerto: s.port,
        direcciones: s.addresses || [],
        equipo: s.txt?.equipo || null,
      });
      emitir();
    });
    this.navegador.on('down', (s) => {
      this.encontrados.delete(s.fqdn || s.name);
      emitir();
    });
  }

  cerrar() {
    try {
      this.navegador?.stop();
      this.bonjour.destroy();
    } catch {
      /* ya cerrado */
    }
  }
}

module.exports = { Anunciante, Buscador, TIPO };
