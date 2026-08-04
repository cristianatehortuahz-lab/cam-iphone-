'use strict';

// Control de acceso.
//
// El servidor escucha en todas las interfaces, asi que sin esto cualquiera
// conectado a la misma WiFi podria abrir el visor y ver la camara, o mandar
// ordenes al iPhone. Dos capas:
//
//   1. Una clave que viaja en la direccion (?c=...) la primera vez y despues
//      queda en una cookie. Se guarda en disco para que no cambie entre
//      arranques y el acceso directo del iPhone siga funcionando.
//   2. Comprobacion de Origin en el WebSocket, para que una pagina cualquiera
//      abierta en otra pestana no pueda hablar con este servidor.
//
// El propio PC (127.0.0.1) queda exento: el estudio y la fuente de OBS se abren
// en local y no tiene sentido pedirles clave.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NOMBRE_COOKIE = 'camclave';

function cargarClave(directorio) {
  const archivo = path.join(directorio, 'clave.txt');
  try {
    const guardada = fs.readFileSync(archivo, 'utf8').trim();
    if (guardada.length >= 8) return guardada;
  } catch {
    /* todavia no existe */
  }
  // Base32 sin caracteres ambiguos: es tecleable a mano si hace falta.
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
  let clave = '';
  const bytes = crypto.randomBytes(12);
  for (const b of bytes) clave += alfabeto[b % alfabeto.length];
  fs.mkdirSync(directorio, { recursive: true });
  fs.writeFileSync(archivo, clave);
  return clave;
}

function esLocal(req) {
  const dir = req.socket.remoteAddress || '';
  return dir === '127.0.0.1' || dir === '::1' || dir === '::ffff:127.0.0.1';
}

function leerCookie(req, nombre) {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

// Comparacion en tiempo constante: evita deducir la clave midiendo respuestas.
function iguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function crearGuardia(clave) {
  // Comprueba una peticion HTTP. Devuelve el veredicto y, si la clave llego por
  // la direccion, pide que se fije la cookie para no arrastrarla en cada enlace.
  function revisar(req, url) {
    if (esLocal(req)) return { permitido: true, fijarCookie: false };

    const enUrl = url.searchParams.get('c');
    if (enUrl && iguales(enUrl, clave)) return { permitido: true, fijarCookie: true };
    if (iguales(leerCookie(req, NOMBRE_COOKIE) || '', clave)) {
      return { permitido: true, fijarCookie: false };
    }
    return { permitido: false, fijarCookie: false };
  }

  // Para el WebSocket: misma clave, mas Origin. El Origin debe apuntar a este
  // mismo servidor; asi una web ajena no puede conectarse aunque adivine algo.
  function revisarSocket(req, puertos) {
    if (!esLocal(req)) {
      let url;
      try {
        url = new URL(req.url, 'https://local');
      } catch {
        return false;
      }
      const enUrl = url.searchParams.get('c');
      const enCookie = leerCookie(req, NOMBRE_COOKIE) || '';
      if (!iguales(enUrl || '', clave) && !iguales(enCookie, clave)) return false;
    }

    const origen = req.headers.origin;
    if (!origen) return true; // clientes que no son navegador no lo envian
    try {
      const o = new URL(origen);
      const anfitrion = o.hostname;
      const puerto = Number(o.port) || (o.protocol === 'https:' ? 443 : 80);
      const anfitrionValido =
        anfitrion === 'localhost' ||
        anfitrion === '127.0.0.1' ||
        /^[\d.]+$/.test(anfitrion); // una IP de la red local
      return anfitrionValido && puertos.includes(puerto);
    } catch {
      return false;
    }
  }

  return { revisar, revisarSocket, NOMBRE_COOKIE };
}

module.exports = { cargarClave, crearGuardia, NOMBRE_COOKIE, esLocal };
