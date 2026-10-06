'use strict';

// El cable hacia un movil Android. Es el equivalente de usbmux.js para el
// iPhone: lista los moviles enchufados y abre un tunel TCP hasta el puerto que
// Nexo Cam escucha en el telefono.
//
// En Android ese tunel lo da `adb forward`, la herramienta de Google
// (platform-tools). Pide que el movil tenga activada la "Depuracion por USB" y
// que se haya aceptado este PC en el aviso que sale al enchufarlo.
//
// `adb forward tcp:P tcp:7000` deja un puerto P en este PC que lleva al 7000 del
// telefono. Cada movil recibe su propio puerto local.

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// Primer puerto local para los tuneles: uno por movil, a partir de aqui.
const PUERTO_BASE = 27100;
const PLAZO = 4000;

let rutaAdb; // undefined = sin buscar todavia; null = no esta
const puertos = new Map(); // serie -> puerto local

// adb.exe: el que deja el instalador de Nexo junto a las herramientas, el del SDK
// de Android si lo hay, o el del PATH.
function buscarAdb() {
  if (rutaAdb !== undefined) return rutaAdb;
  const candidatos = [
    process.env.NEXO_ADB,
    path.join(__dirname, '..', '..', '..', 'herramientas', 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  rutaAdb = candidatos.find((c) => fs.existsSync(c)) || null;
  return rutaAdb;
}

function adb(args) {
  return new Promise((ok, mal) => {
    const exe = buscarAdb();
    if (!exe) return mal(new Error('falta adb (platform-tools de Android)'));
    execFile(exe, args, { timeout: PLAZO, windowsHide: true }, (e, salida, errores) => {
      if (e) mal(new Error((errores || e.message).toString().trim().split('\n')[0]));
      else ok(salida.toString());
    });
  });
}

function disponible() {
  return Boolean(buscarAdb());
}

// Los moviles enchufados: [{ serie, listo }]. `listo` es falso mientras no se
// acepte este PC en el aviso de depuracion del telefono ("unauthorized").
async function listarDispositivos() {
  if (!disponible()) return [];
  const salida = await adb(['devices']);
  const lista = [];
  for (const linea of salida.split(/\r?\n/).slice(1)) {
    const m = linea.match(/^(\S+)\s+(device|unauthorized|offline)\b/);
    if (m) lista.push({ serie: m[1], listo: m[2] === 'device', estado: m[2] });
  }
  return lista;
}

// Abre el tunel y devuelve el socket ya conectado.
//
// Ojo: adb acepta la conexion local aunque Nexo Cam no este abierta en el movil,
// y la cierra al momento. Quien llama lo ve como una sesion que termina sin
// haber saludado, igual que un iPhone con la app cerrada.
async function conectar(serie, puertoMovil) {
  let local = puertos.get(serie);
  if (!local) {
    local = PUERTO_BASE + puertos.size;
    puertos.set(serie, local);
  }
  await adb(['-s', serie, 'forward', `tcp:${local}`, `tcp:${puertoMovil}`]);
  return new Promise((ok, mal) => {
    const socket = net.connect({ host: '127.0.0.1', port: local });
    const plazo = setTimeout(() => { socket.destroy(); mal(new Error('el tunel de adb no respondio')); }, PLAZO);
    socket.once('connect', () => { clearTimeout(plazo); socket.setNoDelay(true); ok(socket); });
    socket.once('error', (e) => { clearTimeout(plazo); mal(e); });
  });
}

module.exports = { disponible, listarDispositivos, conectar, buscarAdb };
