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
// Con --directa el productor se escucha por la perilla "Direct" de su interfaz
// (sin retraso y sin efectos, que no los necesita: decidido el 06/10/2026), asi
// que su voz NO debe volverle desde Reaper: la oiria doble. Su pista sale por
// los canales 3/4 del Master, que no van a los auriculares, y el ReaStream suma
// 1/2 + 3/4 para que al directo si llegue. Las salidas 1/2, las que oyen los
// dos, se quedan con el beat y el cantante.
const DIRECTA = process.argv.includes('--directa');
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

// "Directo - cantar" deja la voz en "solo monitoreo" (cuarto valor de REC = 2):
// suena pero el boton de grabar no graba nada. Aqui se graban las canciones del
// directo (06/10/2026: "no puedo grabar"), asi que la del cantante (entrada 1)
// pasa a 0 = grabar entrada. La del productor se queda en solo monitoreo: sale
// al directo pero no debe quedar grabada (10/10/2026).
if (ENTRADA) {
  for (let i = 0; i < salida.length; i++) salida[i] = salida[i].replace(/^(\s*REC 1 0 \d+) 2 /, '$1 0 ');
}

if (DIRECTA) {
  if (!ENTRADA) throw new Error('--directa solo vale con --entrada');
  const en = (re) => { const i = salida.findIndex((x) => re.test(x)); if (i < 0) throw new Error('no encuentro ' + re); return i; };
  // La pista del productor (la segunda), a los canales 3/4 del Master.
  const p = en(/NAME "Voz productor/);
  const m = salida.findIndex((x, i) => i > p && /^\s*MAINSEND /.test(x));
  salida[m] = salida[m].replace(/MAINSEND .*/, 'MAINSEND 1 2');
  // Master de 4 canales: solo 1/2 sale por el driver. Los 3/4 no van a ninguna
  // salida: sacarlos por la 5/6 y mezclarlos en VoiceMeeter (modo Amix del bus)
  // dejo los auriculares de la AIR solo por la izquierda (06/10/2026).
  const n = en(/^\s*MASTER_NCH /);
  salida[n] = salida[n].replace(/MASTER_NCH \d+/, 'MASTER_NCH 4');
  // Patillas del ReaStream del Master. Su cabecera: 8 bytes, n.o de entradas,
  // una mascara de canales de 8 bytes por entrada, n.o de salidas y sus mascaras.
  // Entrada izquierda = canales 1+3, derecha = 2+4; salidas sueltas, para que
  // no devuelva la suma a los canales 1/2.
  const r = en(/^\s*<VST "VST: ReaStream/);
  const a = Buffer.from(salida[r + 1].trim(), 'base64'), b = Buffer.from(salida[r + 2].trim(), 'base64');
  const c = Buffer.concat([a, b]);
  if (c.readUInt32LE(8) !== 8 || c.readUInt32LE(76) !== 8) throw new Error('la cabecera de ReaStream no es la esperada: no la toco');
  c.writeBigUInt64LE(5n, 12); c.writeBigUInt64LE(10n, 20);
  for (let k = 0; k < 8; k++) c.writeBigUInt64LE(0n, 80 + 8 * k);
  const sg = salida[r + 1].match(/^\s*/)[0];
  salida[r + 1] = sg + c.subarray(0, a.length).toString('base64');
  salida[r + 2] = sg + c.subarray(a.length).toString('base64');
}
if (fs.existsSync(DESTINO)) fs.copyFileSync(DESTINO, DESTINO + '.anterior');
fs.writeFileSync(DESTINO, salida.join('\n'));

const abiertos = salida.filter((x) => x.trim().startsWith('<')).length;
const cerrados = salida.filter((x) => x.trim() === '>').length;
console.log(`plantilla: ${DESTINO}`);
console.log(`bloques abiertos ${abiertos}, cerrados ${cerrados}; la pista "Voz productor" ` +
  (ENTRADA ? `lee la entrada ${ENTRADA} del driver` : `recibe ReaStream "${ID}"`));
if (abiertos !== cerrados) process.exit(1);
