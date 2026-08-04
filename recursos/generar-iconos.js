'use strict';

// Deriva TODOS los recursos graficos a partir del logo maestro (recursos/marca/
// logo.js). Un solo comando -> iconos de Windows, catalogo de iOS, bandeja,
// pantalla de carga y graficos del README. Reejecutar tras tocar el logo.
//
//   node recursos/generar-iconos.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');
const { iconoApp, iconoMono, logotipo, MARCA } = require('./marca/logo');

const RAIZ = path.join(__dirname, '..');
const dir = (...p) => path.join(RAIZ, ...p);

function asegurar(directorio) {
  fs.mkdirSync(directorio, { recursive: true });
}

const bufIcono = Buffer.from(iconoApp());
const bufMono = Buffer.from(iconoMono('#ffffff'));
const bufLogo = Buffer.from(logotipo());

// Render de un SVG a PNG de tamano exacto.
function png(buf, tam, opciones = {}) {
  let s = sharp(buf, { density: 384 }).resize(tam, tam, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (opciones.fondo) s = s.flatten({ background: opciones.fondo });
  return s.png().toBuffer();
}

async function generarWindows() {
  const salida = dir('nexo-desktop', 'recursos');
  asegurar(salida);

  // .ico multi-resolucion: el icono de la app, la ventana y el instalador.
  const tamsIco = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(tamsIco.map((t) => png(bufIcono, t)));
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(salida, 'icono.ico'), ico);

  // PNG grande para electron-builder (genera el resto si hace falta) y tienda.
  fs.writeFileSync(path.join(salida, 'icono-512.png'), await png(bufIcono, 512));
  fs.writeFileSync(path.join(salida, 'icono-1024.png'), await png(bufIcono, 1024));

  // Bandeja del sistema: version pequena, nitida. Windows la escala a 16.
  fs.writeFileSync(path.join(salida, 'bandeja.png'), await png(bufIcono, 32));
  fs.writeFileSync(path.join(salida, 'bandeja-mono.png'), await png(bufMono, 32));

  return { archivos: 5, tamsIco };
}

async function generarIOS() {
  // Xcode moderno (14+) admite un unico 1024 en el catalogo de iconos.
  const salida = dir('nexo-ios', 'Sources', 'Assets.xcassets', 'AppIcon.appiconset');
  asegurar(salida);

  fs.writeFileSync(path.join(salida, 'icono-1024.png'), await png(bufIcono, 1024));

  const contents = {
    images: [{ filename: 'icono-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'nexo', version: 1 },
  };
  fs.writeFileSync(path.join(salida, 'Contents.json'), JSON.stringify(contents, null, 2));

  // Un AccentColor a juego, por si la interfaz lo referencia.
  const colorDir = dir('nexo-ios', 'Sources', 'Assets.xcassets', 'AccentColor.colorset');
  asegurar(colorDir);
  fs.writeFileSync(
    path.join(colorDir, 'Contents.json'),
    JSON.stringify(
      {
        colors: [{ idiom: 'universal', color: { 'color-space': 'srgb', components: { red: '0.239', green: '0.608', blue: '1.000', alpha: '1.000' } } }],
        info: { author: 'nexo', version: 1 },
      },
      null,
      2
    )
  );

  return { archivos: 3 };
}

async function generarPantallaCarga() {
  // Pantalla de carga de Electron: logotipo centrado sobre el fondo de marca.
  const A = 640;
  const AL = 400;
  const fondo = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${A}" height="${AL}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="${A}" y2="${AL}" gradientUnits="userSpaceOnUse">
         <stop offset="0" stop-color="${MARCA.fondo0}"/><stop offset="1" stop-color="${MARCA.fondo1}"/>
       </linearGradient></defs>
       <rect width="${A}" height="${AL}" fill="url(#g)"/>
     </svg>`
  );
  const logoPng = await sharp(bufLogo, { density: 384 }).resize(460).png().toBuffer();
  const salida = dir('nexo-desktop', 'recursos');
  asegurar(salida);
  await sharp(fondo)
    .composite([{ input: logoPng, gravity: 'centre' }])
    .png()
    .toFile(path.join(salida, 'carga.png'));
  return { archivos: 1 };
}

async function generarMarca() {
  // Graficos para el README y documentacion.
  const salida = dir('recursos', 'marca');
  asegurar(salida);
  fs.writeFileSync(path.join(salida, 'logotipo.png'), await sharp(bufLogo, { density: 384 }).resize(1180, 320, { fit: 'contain', background: MARCA.fondo1 }).flatten({ background: MARCA.fondo1 }).png().toBuffer());
  fs.writeFileSync(path.join(salida, 'icono-512.png'), await png(bufIcono, 512));
  // SVGs maestros, versionables.
  fs.writeFileSync(path.join(salida, 'icono.svg'), iconoApp());
  fs.writeFileSync(path.join(salida, 'logotipo.svg'), logotipo());
  fs.writeFileSync(path.join(salida, 'mono.svg'), iconoMono('#ffffff'));
  return { archivos: 5 };
}

function limpiarPrevios() {
  // Borra los _prev_* usados durante el diseno.
  const salida = dir('recursos', 'marca');
  for (const f of fs.readdirSync(salida)) {
    if (f.startsWith('_prev_')) fs.unlinkSync(path.join(salida, f));
  }
}

(async () => {
  console.log('Generando recursos de Nexo desde el logo maestro...\n');
  const w = await generarWindows();
  console.log(`  Windows : icono.ico (${w.tamsIco.join(', ')}), icono-512/1024, bandeja x2`);
  const i = await generarIOS();
  console.log('  iOS     : AppIcon 1024 + Contents.json, AccentColor');
  await generarPantallaCarga();
  console.log('  Carga   : carga.png (pantalla de arranque)');
  await generarMarca();
  console.log('  Marca   : logotipo.png, icono-512, SVGs maestros');
  limpiarPrevios();
  console.log('\nListo.');
})().catch((e) => {
  console.error('Error generando iconos:', e);
  process.exit(1);
});
