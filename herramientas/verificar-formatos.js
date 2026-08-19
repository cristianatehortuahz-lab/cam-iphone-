'use strict';

// Certifica que NINGUNA combinacion de lente y formato sale mal.
//
// Se conecta al iPhone por el cable (usbmux), recorre lente x formato pidiendo
// cada uno, y comprueba sobre el flujo real seis cosas:
//
//   orientacion  vertical pedido -> alto > ancho, y al reves
//   proporcion   la del flujo coincide con la pedida
//   resolucion   las medidas codificadas son las pedidas
//   fluidez      los fps medidos se acercan a los pedidos
//   clave        llegan fotogramas IDR y con su flag bien puesto
//   sin escalar  lo codificado coincide con el formato del sensor
//
// La ultima es la mas fuerte: en vez de mirar la imagen, comprueba que
// VideoToolbox no escalo, que es la unica forma de que se deforme.
//
// Las medidas se sacan con ffprobe en vez de analizando el SPS a mano: es una
// dependencia que ya hace falta para el resto del proyecto y no se equivoca.
//
// Uso:  node herramientas/verificar-formatos.js [--rapido]
// Sale con codigo distinto de cero si algo falla.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const usbmux = require(path.join(RAIZ, 'nexo-desktop/src/main/usbmux.js'));
const proto = require(path.join(RAIZ, 'nexo-desktop/src/main/protocolo.js'));
const { CABLE_IPHONE } = require(path.join(RAIZ, 'nexo-desktop/src/main/puertos.js'));

const RAPIDO = process.argv.includes('--rapido');
const FPS = 30;
const TMP = path.join(os.tmpdir(), 'nexo-verificar');

// Los formatos que ofrece el estudio. Con --rapido, solo los dos que mas fallaban.
const FORMATOS = RAPIDO
  ? [[1080, 1920], [1920, 1080]]
  : [
      [1080, 1920], [720, 1280], [2160, 3840],
      [1920, 1080], [1280, 720], [2560, 1440], [3840, 2160],
    ];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ¿Contiene el fotograma una IDR de verdad? (NAL Annex-B tipo 5)
function tieneIDR(datos) {
  for (let i = 0; i + 4 < datos.length; i++) {
    const c3 = datos[i] === 0 && datos[i + 1] === 0 && datos[i + 2] === 1;
    const c4 = !c3 && datos[i] === 0 && datos[i + 1] === 0 && datos[i + 2] === 0 && datos[i + 3] === 1;
    if (!c3 && !c4) continue;
    if ((datos[i + (c4 ? 4 : 3)] & 0x1f) === 5) return true;
    i += c4 ? 3 : 2;
  }
  return false;
}

// Medidas reales del flujo, segun ffprobe.
function medidasDelFlujo(fotogramas, etiqueta) {
  fs.mkdirSync(TMP, { recursive: true });
  const archivo = path.join(TMP, etiqueta.replace(/[^\w.-]/g, '_') + '.h264');
  fs.writeFileSync(archivo, Buffer.concat(fotogramas));
  try {
    const salida = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', archivo,
    ], { encoding: 'utf8', timeout: 20000 }).trim();
    const [ancho, alto] = salida.split(',').map(Number);
    return ancho && alto ? { ancho, alto } : null;
  } catch {
    return null;
  }
}

async function probar(mandar, lente, pedido, ref) {
  const [pw, ph] = pedido;
  mandar({ accion: 'cambiar-lente', valor: lente.id });
  await dormir(2200);
  mandar({ accion: 'cambiar-resolucion', valor: `${pw}x${ph}` });
  await dormir(2800);

  ref.fotogramas = [];
  ref.claves = 0;
  ref.capturando = true;
  const t0 = Date.now();
  await dormir(3000);
  ref.capturando = false;
  const segundos = (Date.now() - t0) / 1000;

  const fallos = [];
  if (!ref.fotogramas.length) return { fallos: ['sin video'], detalle: '-' };

  const etiqueta = `${lente.nombre.split(' ')[0]}-${pw}x${ph}`;
  const medidas = medidasDelFlujo(ref.fotogramas, etiqueta);
  if (!medidas) return { fallos: ['ffprobe no pudo leer el flujo'], detalle: '-' };
  const { ancho, alto } = medidas;

  // 1. Orientacion
  const pedidoVertical = ph > pw;
  const realVertical = alto > ancho;
  if (pedidoVertical !== realVertical) {
    fallos.push(`orientacion: pedido ${pedidoVertical ? 'vertical' : 'horizontal'}, real ${realVertical ? 'vertical' : 'horizontal'}`);
  }

  // 2. Proporcion
  const propPedida = Math.max(pw, ph) / Math.min(pw, ph);
  const propReal = Math.max(ancho, alto) / Math.min(ancho, alto);
  if (Math.abs(propPedida - propReal) / propPedida > 0.01) {
    fallos.push(`proporcion: ${propPedida.toFixed(3)} pedida vs ${propReal.toFixed(3)} real`);
  }

  // 3. Resolucion exacta
  if (ancho !== pw || alto !== ph) fallos.push(`resolucion: ${ancho}x${alto}`);

  // 4. Fluidez
  const fps = ref.fotogramas.length / segundos;
  if (fps < FPS * 0.8) fallos.push(`fluidez: ${fps.toFixed(1)} fps`);

  // 5. Claves presentes y bien marcadas
  const idr = ref.fotogramas.filter(tieneIDR).length;
  if (idr === 0) fallos.push('sin fotogramas clave');
  else if (ref.claves === 0) fallos.push('claves presentes pero sin marcar (flag)');

  // 6. Sin escalar: lo codificado es el formato del sensor, girado o no
  const sensor = ref.ultimoEstado && ref.ultimoEstado.formatoSensor;
  if (sensor) {
    const [sw, sh] = sensor.split('x').map(Number);
    const coincide = (ancho === sw && alto === sh) || (ancho === sh && alto === sw);
    if (!coincide) fallos.push(`escalado: sensor ${sensor} -> codificado ${ancho}x${alto}`);
  }

  return { fallos, detalle: `${ancho}x${alto} ${fps.toFixed(0)}fps ${idr}idr` };
}

(async () => {
  const dispositivos = await usbmux.listarDispositivos();
  if (!dispositivos.length) {
    console.error('No hay ningun iPhone conectado por cable.');
    process.exit(1);
  }

  const { socket, sobrante } = await usbmux.conectar(dispositivos[0].deviceID, CABLE_IPHONE);
  const ref = { fotogramas: [], claves: 0, capturando: false, ultimoEstado: null };

  const an = new proto.Analizador({
    onSaludo: () => {},
    onError: (e) => console.error('  protocolo:', e.message),
    onTrama: (t) => {
      if (t.nombre === 'video' && ref.capturando) {
        ref.fotogramas.push(t.datos);
        if (t.clave) ref.claves++;
      }
      if (t.nombre === 'estado') ref.ultimoEstado = t.obj;
    },
  });
  socket.on('data', (x) => an.feed(x));
  if (sobrante && sobrante.length) an.feed(sobrante);
  socket.write(proto.codificarSaludo({ rol: 'receptor', app: 'verificador' }));

  const mandar = (o) => socket.write(proto.codificarJson(proto.TRAMA.CONTROL, o));

  await dormir(2000);
  if (!ref.ultimoEstado) {
    console.error('El iPhone no publico su estado. ¿Esta Nexo Cam abierta y en pantalla?');
    process.exit(1);
  }

  const lentes = ref.ultimoEstado.lentes || [];
  console.log(`Verificando ${lentes.length} lentes x ${FORMATOS.length} formatos a ${FPS} fps`);
  console.log('');

  let fallidas = 0;
  for (const lente of lentes) {
    for (const pedido of FORMATOS) {
      const etiqueta = `${lente.nombre.split(' ')[0]} ${pedido[0]}x${pedido[1]}`;
      const { fallos, detalle } = await probar(mandar, lente, pedido, ref);
      if (fallos.length) {
        fallidas++;
        console.log(`FALLA  ${etiqueta.padEnd(28)} ${detalle}`);
        for (const f of fallos) console.log(`         -> ${f}`);
      } else {
        console.log(`ok     ${etiqueta.padEnd(28)} ${detalle}`);
      }
    }
  }

  const total = lentes.length * FORMATOS.length;
  console.log('');
  console.log(`${total - fallidas}/${total} combinaciones correctas`);
  socket.destroy();
  process.exit(fallidas ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
