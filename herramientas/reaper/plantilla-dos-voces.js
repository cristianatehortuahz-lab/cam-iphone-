'use strict';

// Crea la plantilla de Reaper "Directo - dos voces" a partir de "Directo -
// cantar": anade una pista "Voz productor" que no lee ninguna entrada de la
// interfaz, sino que RECIBE por ReaStream el micro de otra interfaz que Nexo
// captura por Windows (nexo-desktop/src/main/micro-windows.js).
//
// Es para dos micros en dos interfaces (AIR 192|4 + M-Track Solo). Reaper solo
// admite un driver ASIO y juntarlas con ASIO4ALL metia ruido en la voz
// (04-05/10/2026); asi Reaper sigue con el ASIO de la principal.
//
// El ReaStream de esa pista se copia del que la plantilla ya lleva en el Master
// (enviar, "nexo-fl") cambiando dos cosas de su estado, comprobadas contra el
// que tiene OBS en modo recibir: el primer entero (1 = enviar, 0 = recibir) y
// el identificador.
//
//   node herramientas/reaper/plantilla-dos-voces.js [identificador]
//
// Reaper tiene que estar cerrado o no vera la plantilla nueva hasta reabrirlo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Con --entrada N la pista del productor lee la entrada N del driver (1 = la
// primera) en vez de recibir por ReaStream: es el caso de VoiceMeeter, que junta
// las dos interfaces en un solo driver ASIO y da cada micro en una entrada.
const iEntrada = process.argv.indexOf('--entrada');
const ENTRADA = iEntrada > 0 ? Number(process.argv[iEntrada + 1]) : 0;
const ID = (iEntrada > 0 ? null : process.argv[2]) || 'nexo-solo';
const DIR = path.join(process.env.APPDATA, 'REAPER', 'ProjectTemplates');
const ORIGEN = path.join(DIR, 'Directo - cantar.RPP');
const DESTINO = path.join(DIR, 'Directo - dos voces.RPP');
const guid = () => '{' + crypto.randomUUID().toUpperCase() + '}';

const l = fs.readFileSync(ORIGEN, 'utf8').split('\n');
const buscar = (re, desde = 0) => { for (let i = desde; i < l.length; i++) if (re.test(l[i])) return i; return -1; };
// Fin del bloque que empieza en la linea i (los bloques abren con "<" y cierran con ">").
function finDe(i) {
  let hondo = 0;
  for (let k = i; k < l.length; k++) {
    const t = l[k].trim();
    if (t.startsWith('<')) hondo++;
    if (t === '>') { hondo--; if (hondo === 0) return k; }
  }
  throw new Error('bloque sin cerrar en la linea ' + (i + 1));
}

// --- El ReaStream del Master, para copiarlo en modo recibir -----------------
const vst = buscar(/^\s*<VST "VST: ReaStream/);
if (vst < 0) throw new Error('la plantilla "Directo - cantar" no lleva ReaStream en el Master');
const finVst = finDe(vst);
const b64 = l.slice(vst + 1, finVst).map((x) => x.trim());
// El estado propio del plugin va en las lineas 3.a y 4.a (172 bytes): modo,
// canales, activo, identificador de 32 bytes, y la direccion de destino.
const estado = Buffer.concat([Buffer.from(b64[2], 'base64'), Buffer.from(b64[3], 'base64')]);
if (estado.length !== 172 || estado.toString('latin1', 12, 19) !== 'nexo-fl') throw new Error('el estado de ReaStream no es el esperado: no lo toco');
estado.writeUInt32LE(0, 0);            // 0 = recibir
estado.fill(0, 12, 44);
estado.write(ID.slice(0, 31), 12, 'latin1');
const sangria = l[vst].match(/^\s*/)[0];
const cadenaFx = [
  `${sangria}<FXCHAIN`,
  `${sangria}  SHOW 0`,
  `${sangria}  LASTSEL 0`,
  `${sangria}  DOCKED 0`,
  `${sangria}  BYPASS 0 0 0`,
  `${sangria}  ${l[vst].trim()}`,
  `${sangria}    ${b64[0]}`,
  `${sangria}    ${b64[1]}`,
  `${sangria}    ${estado.subarray(0, 96).toString('base64')}`,
  `${sangria}    ${estado.subarray(96).toString('base64')}`,
  ...b64.slice(4).map((x) => `${sangria}    ${x}`),
  `${sangria}  >`,
  `${sangria}  FLOATPOS 0 0 0 0`,
  `${sangria}  FXID ${guid()}`,
  `${sangria}  WAK 0 0`,
  `${sangria}>`,
];

// --- La pista de voz, duplicada ---------------------------------------------
const voz = buscar(/^\s*<TRACK /);
const finVoz = finDe(voz);
const idVoz = l[voz].match(/\{[^}]+\}/)[0];
const idProd = guid();
const cantante = l.slice(voz, finVoz + 1).map((x) => x.replace(/NAME ".*"/, 'NAME "Voz cantante (AIR In 1)"'));
const productor = [];
for (const x of l.slice(voz, finVoz)) {
  if (/^\s*<FXCHAIN/.test(x)) throw new Error('la pista de voz de origen lleva efectos: no se como duplicarla');
  productor.push(ENTRADA
    // Como la del cantante (armada, monitoreo, sin grabar), en otra entrada.
    ? x.split(idVoz).join(idProd)
      .replace(/NAME ".*"/, `NAME "Voz productor (Solo In 1)"`)
      .replace(/^(\s*)REC (\d+) \d+ /, `$1REC $2 ${ENTRADA - 1} `)
    : x.split(idVoz).join(idProd)
      .replace(/NAME ".*"/, `NAME "Voz productor (red: ${ID})"`)
      // Sin armar y sin entrada: su audio lo pone el ReaStream. El cuarto valor
      // (1) hace que, si se arma para grabar, grabe lo que SALE de la pista.
      .replace(/^(\s*)REC .*/, '$1REC 0 0 0 1 0 0 0 0')
  );
}
if (!ENTRADA) productor.push(...cadenaFx.map((x) => x.replace(sangria, l[voz].match(/^\s*/)[0] + '  ')));
productor.push(l[finVoz]);

const salida = [...l.slice(0, voz), ...cantante, ...productor, ...l.slice(finVoz + 1)];
if (fs.existsSync(DESTINO)) fs.copyFileSync(DESTINO, DESTINO + '.anterior');
fs.writeFileSync(DESTINO, salida.join('\n'));

const abiertos = salida.filter((x) => x.trim().startsWith('<')).length;
const cerrados = salida.filter((x) => x.trim() === '>').length;
console.log(`plantilla: ${DESTINO}`);
console.log(`bloques abiertos ${abiertos}, cerrados ${cerrados}; la pista "Voz productor" ` +
  (ENTRADA ? `lee la entrada ${ENTRADA} del driver` : `recibe ReaStream "${ID}"`));
if (abiertos !== cerrados) process.exit(1);
