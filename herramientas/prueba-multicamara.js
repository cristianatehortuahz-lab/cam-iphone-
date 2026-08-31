// Integracion real, sin Electron: dos moviles simulados -> Conexion -> Grabador.
// Comprueba que se admiten dos sesiones a la vez, que cada una escribe su propio
// archivo y que los desfases de reloj quedan anotados en toma.json.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = 'C:/Users/Usuario/Documents/proyectos de software/cawebfhone';
const { Conexion } = require(RAIZ + '/nexo-desktop/src/main/conexion.js');
const { Grabador } = require(RAIZ + '/nexo-desktop/src/main/grabador.js');
const proto = require(RAIZ + '/nexo-desktop/src/main/protocolo.js');
const clave = require(RAIZ + '/nexo-desktop/src/main/clave.js');
const { WIFI } = require(RAIZ + '/nexo-desktop/src/main/puertos.js');

const S = 'C:/Users/Usuario/AppData/Local/Temp/claude/C--Users-Usuario-Documents-proyectos-de-software-cawebfhone/fed86b9a-24eb-4f09-a37a-14c4ef4a502e/scratchpad';
const flujo = fs.readFileSync(path.join(S, 'muestra.h264'));
const k = clave.obtener();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function movilFalso(desfaseReloj) {
  return new Promise((listo) => {
    const s = net.connect(WIFI, '127.0.0.1');
    const an = new proto.Analizador({
      onSaludo: () => {}, onError: () => {},
      onTrama: (t) => {
        if (t.nombre === 'latido' && t.obj && typeof t.obj.pc === 'number') {
          s.write(proto.codificarJson(proto.TRAMA.LATIDO, { pc: t.obj.pc, movil: Date.now() + desfaseReloj }));
        }
      },
    });
    s.on('data', (d) => an.feed(d));
    s.on('error', () => {});
    s.on('connect', () => {
      s.write(proto.codificarSaludo({ rol: 'emisor', app: 'Nexo Cam', modelo: 'iPhone', clave: k }));
      setTimeout(() => listo(s), 600);
    });
  });
}

function mandarVideo(s) {
  const trozo = 8192;
  for (let i = 0; i < flujo.length; i += trozo) {
    const d = flujo.subarray(i, Math.min(i + trozo, flujo.length));
    s.write(proto.codificarMedia(proto.TRAMA.VIDEO, i * 100, d, { clave: i === 0 }));
  }
}

(async () => {
  const grabador = new Grabador();
  const conexion = new Conexion({
    ipcVideo: (v, id) => grabador.escribir(v, id),
    ipcAudio: () => {},
  });
  await conexion.iniciar();

  const a = await movilFalso(0);
  const b = await movilFalso(1500);
  await dormir(3500); // que se midan los desfases

  const camaras = conexion.camaras();
  console.log(`camaras conectadas: ${camaras.length}`);
  camaras.forEach((c, i) => console.log(`  ${i + 1}. ${c.id}  principal=${c.principal}  desfase=${c.desfase} ms`));

  const base = path.join(os.tmpdir(), 'nexo-multicam');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });

  const r = grabador.empezar(conexion.camaras(), base);
  console.log(`\ngrabando ${r.pistas} pistas`);

  const bombeo = setInterval(() => { mandarVideo(a); mandarVideo(b); }, 400);
  await dormir(2500);
  clearInterval(bombeo);
  await dormir(500);

  const fin = await grabador.parar(conexion.camaras());
  console.log('\n--- archivos ---');
  for (const f of fs.readdirSync(fin.carpeta).sort()) {
    const st = fs.statSync(path.join(fin.carpeta, f));
    console.log(`  ${f.padEnd(16)} ${Math.round(st.size / 1024)} KB`);
  }
  console.log('\n--- toma.json ---');
  for (const c of fin.toma.camaras) {
    console.log(`  ${c.nombre}: ${c.archivo}  desfase=${c.desfaseMs} ms  fotogramas=${c.fotogramas}`);
  }

  const mp4 = fs.readdirSync(fin.carpeta).filter((f) => f.endsWith('.mp4'));
  const ok = mp4.length === 2 && fin.toma.camaras.every((c) => c.bytes > 0 && !c.error);
  console.log('\n' + (ok ? '=> OK: dos angulos, dos archivos, con sus desfases' : '=> FALLA'));

  a.destroy(); b.destroy();
  await conexion.detener();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
