'use strict';

// Protocolo binario de Nexo. Funciona igual sobre el tunel USB (usbmux) que
// sobre una conexion WiFi: es solo un flujo de bytes. Se abandona WebRTC porque
// necesita ICE/UDP y no encaja en un tunel TCP.
//
//   Saludo (una vez, al abrir):
//     "NEXO1" (5 bytes) | version u8 | longitud u32-BE | JSON de capacidades
//
//   Tramas (repetidas):
//     tipo u8 | longitud u32-BE | carga (longitud bytes)
//
//   Tipos de trama:
//     1 VIDEO    H.264 Annex-B. Los 9 primeros bytes de la carga son:
//                  u64-BE marca de tiempo (microsegundos)
//                  u8 flags (bit 0 = fotograma clave; el resto reservados)
//                y despues las NAL. Sin el flag de clave el decodificador se
//                quedaria en pantalla negra esperando la primera IDR.
//     2 AUDIO    AAC (u64 tiempo + u8 flags + datos)
//     3 ESTADO   JSON: lente, zoom, ISO, bateria, temperatura del movil
//     4 CONTROL  JSON: ordenes del PC al movil (lente, zoom, foco, linterna...)
//     5 LATIDO   vacio; mantiene viva la conexion y mide la latencia

const MAGIA = Buffer.from('NEXO1', 'ascii');
const VERSION = 1;

// Techo de tamano de trama. La longitud viaja como u32, asi que sin limite un
// par puede declarar 4 GB y gotear bytes: el analizador acumularia hasta agotar
// la memoria del proceso. 4 MB deja holgura de sobra para un fotograma clave a
// 4K (un IDR a 32 Mbps ronda los 400 KB) y corta el ataque en seco.
// Si cambia aqui, cambiar tambien MAX_TRAMA en ProtocoloNexo.swift.
const MAX_TRAMA = 4 * 1024 * 1024;

const TRAMA = { VIDEO: 1, AUDIO: 2, ESTADO: 3, CONTROL: 4, LATIDO: 5 };
const NOMBRE = { 1: 'video', 2: 'audio', 3: 'estado', 4: 'control', 5: 'latido' };

// --- Codificar --------------------------------------------------------------

function codificarSaludo(capacidades = {}) {
  const json = Buffer.from(JSON.stringify(capacidades), 'utf8');
  const cab = Buffer.alloc(MAGIA.length + 1 + 4);
  MAGIA.copy(cab, 0);
  cab.writeUInt8(VERSION, MAGIA.length);
  cab.writeUInt32BE(json.length, MAGIA.length + 1);
  return Buffer.concat([cab, json]);
}

function codificarTrama(tipo, carga = Buffer.alloc(0)) {
  const cab = Buffer.alloc(5);
  cab.writeUInt8(tipo, 0);
  cab.writeUInt32BE(carga.length, 1);
  return Buffer.concat([cab, carga]);
}

// Media (video/audio) con marca de tiempo + byte de flags + datos. Bit 0 de
// flags = fotograma clave (para video); en audio no se usa.
function codificarMedia(tipo, microsegundos, datos, { clave = false } = {}) {
  const cab = Buffer.alloc(9);
  cab.writeBigUInt64BE(BigInt(microsegundos), 0);
  cab.writeUInt8(clave ? 1 : 0, 8);
  return codificarTrama(tipo, Buffer.concat([cab, datos]));
}

function codificarJson(tipo, obj) {
  return codificarTrama(tipo, Buffer.from(JSON.stringify(obj), 'utf8'));
}

// --- Analizador de flujo ----------------------------------------------------

// TCP entrega los bytes troceados como quiera, asi que hay que acumular hasta
// tener una trama completa. Se alimenta con feed() y llama a los callbacks.
class Analizador {
  constructor({ onSaludo, onTrama, onError } = {}) {
    this.buffer = Buffer.alloc(0);
    this.saludoHecho = false;
    // Un flujo que incumple el protocolo no se recupera: se marca roto y se deja
    // de leer. Quien nos alimenta cierra el socket al ver el error fatal.
    this.roto = false;
    this.onSaludo = onSaludo || (() => {});
    this.onTrama = onTrama || (() => {});
    this.onError = onError || (() => {});
  }

  feed(trozo) {
    if (this.roto) return;
    this.buffer = Buffer.concat([this.buffer, trozo]);
    // Un solo trozo puede completar varias tramas: se procesan en bucle.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.saludoHecho) {
        if (!this.#leerSaludo()) break;
      } else if (!this.#leerTrama()) {
        break;
      }
    }
  }

  // Corta el flujo para siempre y avisa con un error marcado como fatal.
  #romper(mensaje) {
    this.roto = true;
    this.buffer = Buffer.alloc(0);
    const err = new Error(mensaje);
    err.fatal = true;
    this.onError(err);
    return false;
  }

  #leerSaludo() {
    const minimo = MAGIA.length + 1 + 4;
    if (this.buffer.length < minimo) return false;

    if (!this.buffer.subarray(0, MAGIA.length).equals(MAGIA)) {
      return this.#romper('Saludo invalido: no es un flujo Nexo');
    }
    const version = this.buffer.readUInt8(MAGIA.length);
    const lonJson = this.buffer.readUInt32BE(MAGIA.length + 1);
    if (lonJson > MAX_TRAMA) {
      return this.#romper(`Saludo de ${lonJson} bytes: supera el maximo de ${MAX_TRAMA}`);
    }
    if (this.buffer.length < minimo + lonJson) return false;

    let capacidades = {};
    try {
      capacidades = JSON.parse(this.buffer.subarray(minimo, minimo + lonJson).toString('utf8'));
    } catch {
      this.onError(new Error('Saludo con JSON invalido'));
    }
    this.buffer = this.buffer.subarray(minimo + lonJson);
    this.saludoHecho = true;
    this.onSaludo({ version, capacidades });
    return true;
  }

  #leerTrama() {
    if (this.buffer.length < 5) return false;
    const tipo = this.buffer.readUInt8(0);
    const longitud = this.buffer.readUInt32BE(1);
    if (longitud > MAX_TRAMA) {
      return this.#romper(`Trama de ${longitud} bytes: supera el maximo de ${MAX_TRAMA}`);
    }
    if (this.buffer.length < 5 + longitud) return false;

    const carga = this.buffer.subarray(5, 5 + longitud);
    this.buffer = this.buffer.subarray(5 + longitud);

    if (tipo === TRAMA.VIDEO || tipo === TRAMA.AUDIO) {
      const microsegundos = carga.length >= 8 ? Number(carga.readBigUInt64BE(0)) : 0;
      const flags = carga.length >= 9 ? carga.readUInt8(8) : 0;
      const clave = (flags & 0x01) !== 0;
      this.onTrama({
        tipo,
        nombre: NOMBRE[tipo],
        microsegundos,
        clave,
        // Copia, no vista: subarray comparte memoria con el buffer de lectura, y
        // el fotograma viaja por IPC hasta el renderer. Con una vista, cada
        // fotograma en vuelo mantendria vivo todo el bloque acumulado.
        datos: Buffer.from(carga.subarray(9)),
      });
    } else if (tipo === TRAMA.ESTADO || tipo === TRAMA.CONTROL) {
      let obj = {};
      try {
        obj = JSON.parse(carga.toString('utf8'));
      } catch {
        /* trama corrupta: se ignora su contenido */
      }
      this.onTrama({ tipo, nombre: NOMBRE[tipo], obj });
    } else {
      this.onTrama({ tipo, nombre: NOMBRE[tipo] || 'desconocido', datos: Buffer.from(carga) });
    }
    return true;
  }
}

module.exports = {
  MAGIA,
  VERSION,
  MAX_TRAMA,
  TRAMA,
  NOMBRE,
  codificarSaludo,
  codificarTrama,
  codificarMedia,
  codificarJson,
  Analizador,
};
