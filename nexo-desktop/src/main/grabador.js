'use strict';

// Graba a disco lo que manda el iPhone, TAL CUAL llega.
//
// La grabacion anterior vivia en el navegador: capturaba el lienzo ya
// procesado, lo recodificaba y acumulaba la pelicula entera en memoria hasta
// pulsar parar. Tres problemas de fondo:
//
//   - Una hora a 16 Mbps son ~7 GB en el proceso de interfaz. Reventaba.
//   - Se dibujaba con requestAnimationFrame, que el navegador congela al
//     minimizar la ventana: justo cuando dejarias algo grabando.
//   - Recodificaba un video que ya venia comprimido del movil, perdiendo
//     calidad y gastando CPU para nada.
//
// Aqui se copian los mismos fotogramas H.264 que entrega la camara, sin
// decodificar. No se acumula nada (se escribe segun llega), no se pierde
// calidad, y no depende de que la ventana este visible ni siquiera abierta.
//
// El contenedor lo hace ffmpeg con `-c copy`, que solo re-empaqueta. Escribir un
// multiplexor MP4 a mano es justo donde viven los errores de sincronia y de
// fotogramas B. Si no hay ffmpeg, se guarda el flujo crudo .h264, que sigue
// siendo reproducible y convertible despues.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Se busca una vez y se recuerda: no tiene sentido preguntarlo en cada toma.
let rutaFfmpeg;
function buscarFfmpeg() {
  if (rutaFfmpeg !== undefined) return rutaFfmpeg;
  for (const candidato of ['ffmpeg', 'ffmpeg.exe']) {
    try {
      const r = spawnSync(candidato, ['-version'], { timeout: 5000 });
      if (r.status === 0) {
        rutaFfmpeg = candidato;
        return rutaFfmpeg;
      }
    } catch {
      /* seguimos probando */
    }
  }
  rutaFfmpeg = null;
  return null;
}

function marcaTiempo(fecha = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}` +
    ` ${p(fecha.getHours())}-${p(fecha.getMinutes())}-${p(fecha.getSeconds())}`
  );
}

// Nombre de archivo legible a partir de la camara. Se prefiere el modelo que
// publica el movil, y si no hay, el identificador de la sesion.
//
// `usados` evita que dos camaras compartan archivo: todos los iPhone se llaman
// "iPhone", asi que sin esto la segunda camara sobrescribia a la primera y una
// grabacion multicamara se perdia entera.
function nombreDeCamara(camara, indice, usados) {
  const bruto =
    (camara.capacidades && camara.capacidades.modelo) ||
    camara.id ||
    `camara-${indice + 1}`;
  const limpio = String(bruto).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `camara-${indice + 1}`;
  if (!usados.has(limpio)) {
    usados.add(limpio);
    return limpio;
  }
  let n = 2;
  while (usados.has(`${limpio}-${n}`)) n++;
  const unico = `${limpio}-${n}`;
  usados.add(unico);
  return unico;
}

// Una pista: un iPhone escribiendo en su propio archivo.
class Pista {
  constructor({ id, nombre, carpeta, fps }) {
    this.id = id;
    this.nombre = nombre;
    this.fps = fps || 30;
    this.bytes = 0;
    this.fotogramas = 0;
    this.esperandoClave = true; // un archivo debe empezar en un fotograma clave
    this.proceso = null;
    this.salida = null;
    this.ruta = null;
    this.error = null;

    const ffmpeg = buscarFfmpeg();
    if (ffmpeg) {
      this.ruta = path.join(carpeta, `${nombre}.mp4`);
      // -c copy: solo re-empaqueta, no recodifica. El flujo entra crudo por la
      // entrada estandar y sale como MP4 con los fotogramas intactos.
      this.proceso = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'h264',
        '-r', String(this.fps),
        '-i', 'pipe:0',
        '-c', 'copy',
        // El MP4 normal solo es reproducible al cerrarse bien; asi una caida a
        // media grabacion deja un archivo que se abre igual.
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-y', this.ruta,
      ]);
      this.proceso.on('error', (e) => { this.error = e.message; });
      this.proceso.stderr.on('data', (d) => {
        const t = d.toString().trim();
        if (t) console.error(`[grabador] ${nombre}: ${t}`);
      });
      // Si ffmpeg se cae, no queremos que escribir reviente el proceso entero.
      this.proceso.stdin.on('error', (e) => { this.error = e.message; });
      this.salida = this.proceso.stdin;
    } else {
      this.ruta = path.join(carpeta, `${nombre}.h264`);
      this.salida = fs.createWriteStream(this.ruta);
      this.salida.on('error', (e) => { this.error = e.message; });
    }
  }

  escribir(v) {
    if (!this.salida || this.error) return;
    // Empezar en un fotograma clave: si no, el principio del archivo son
    // diferencias contra una imagen que no existe y no hay quien lo abra.
    if (this.esperandoClave) {
      if (!v.clave) return;
      this.esperandoClave = false;
    }
    this.bytes += v.datos.length;
    this.fotogramas++;
    // Sin await ni acumulacion: si el disco no da abasto, el propio flujo hace
    // de freno. Nunca se guarda la pelicula en memoria.
    this.salida.write(v.datos);
  }

  async cerrar() {
    return new Promise((resolver) => {
      if (!this.salida) return resolver();
      const acabar = () => resolver();
      if (this.proceso) {
        this.proceso.once('close', acabar);
        // Cerrar la entrada hace que ffmpeg escriba el cierre del contenedor.
        this.salida.end();
        // Red de seguridad: si no termina, no bloqueamos el cierre de la app.
        setTimeout(() => { try { this.proceso.kill(); } catch {} resolver(); }, 5000);
      } else {
        this.salida.end(acabar);
      }
    });
  }

  resumen() {
    return {
      id: this.id,
      nombre: this.nombre,
      archivo: this.ruta ? path.basename(this.ruta) : null,
      fotogramas: this.fotogramas,
      bytes: this.bytes,
      error: this.error,
    };
  }
}

class Grabador {
  constructor() {
    this.pistas = new Map();
    this.carpeta = null;
    this.inicio = null;
  }

  get grabando() {
    return this.pistas.size > 0;
  }

  hayFfmpeg() {
    return Boolean(buscarFfmpeg());
  }

  // Abre una carpeta por toma y una pista por camara conectada.
  empezar(camaras, carpetaBase) {
    if (this.grabando) return { ok: false, motivo: 'ya se esta grabando' };
    if (!camaras.length) return { ok: false, motivo: 'no hay ninguna camara conectada' };

    const carpeta = path.join(carpetaBase, `Toma ${marcaTiempo()}`);
    try {
      fs.mkdirSync(carpeta, { recursive: true });
    } catch (e) {
      return { ok: false, motivo: `no se pudo crear la carpeta: ${e.message}` };
    }

    this.carpeta = carpeta;
    this.inicio = Date.now();

    const usados = new Set();
    camaras.forEach((camara, i) => {
      const fps = (camara.estadoMovil && camara.estadoMovil.fps) || 30;
      const pista = new Pista({
        id: camara.id,
        nombre: nombreDeCamara(camara, i, usados),
        carpeta,
        fps,
      });
      this.pistas.set(camara.id, pista);
    });

    console.log(`[grabador] grabando ${this.pistas.size} camara(s) en ${carpeta}`);
    return { ok: true, carpeta, pistas: this.pistas.size, ffmpeg: this.hayFfmpeg() };
  }

  // Cada fotograma que llega, a su pista. Las camaras que se conecten a mitad de
  // toma no se graban: un archivo que empieza tarde solo confunde al montar.
  escribir(v, id) {
    const pista = this.pistas.get(id);
    if (pista) pista.escribir(v);
  }

  async parar(camaras = []) {
    if (!this.grabando) return { ok: false, motivo: 'no se estaba grabando' };

    const pistas = [...this.pistas.values()];
    this.pistas.clear();
    await Promise.all(pistas.map((p) => p.cerrar()));

    // Metadatos al lado: que lente, que resolucion y que desfase tenia cada
    // angulo. Sin esto hay que adivinarlo al montar.
    const toma = {
      inicio: new Date(this.inicio).toISOString(),
      duracionSegundos: Math.round((Date.now() - this.inicio) / 1000),
      camaras: pistas.map((p) => {
        const camara = camaras.find((c) => c.id === p.id) || {};
        const estado = camara.estadoMovil || {};
        return {
          ...p.resumen(),
          origen: camara.origen || null,
          desfaseMs: camara.desfase ?? null,
          resolucion: estado.resolucionReal || estado.resolucion || null,
          fps: estado.fps || null,
          lente: estado.lenteActual || null,
        };
      }),
    };
    try {
      fs.writeFileSync(path.join(this.carpeta, 'toma.json'), JSON.stringify(toma, null, 2));
    } catch (e) {
      console.error('[grabador] no se pudo escribir toma.json:', e.message);
    }

    const carpeta = this.carpeta;
    this.carpeta = null;
    this.inicio = null;
    console.log(`[grabador] toma cerrada: ${carpeta}`);
    return { ok: true, carpeta, toma };
  }

  estado() {
    return {
      grabando: this.grabando,
      carpeta: this.carpeta,
      segundos: this.inicio ? Math.round((Date.now() - this.inicio) / 1000) : 0,
      ffmpeg: this.hayFfmpeg(),
      pistas: [...this.pistas.values()].map((p) => p.resumen()),
    };
  }
}

module.exports = { Grabador, marcaTiempo };
