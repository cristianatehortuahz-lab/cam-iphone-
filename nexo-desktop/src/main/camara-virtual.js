'use strict';

// La camara de Nexo como webcam de Windows.
//
// Hasta ahora TikTok LIVE Studio veia a Nexo capturando una ventana ("Nexo -
// Camara 1:1"): la imagen pasaba por el compositor de Windows, dependia de que
// la ventana no se minimizara ni se recreara, y costaba un Electron entero
// decodificando. Aqui el video del iPhone se publica como una camara de verdad,
// y la aplicacion que sea (TikTok, Zoom, Discord) la elige en su fuente
// "Camara".
//
// La camara es la "OBS Virtual Camera" que ya instala OBS: no hay que registrar
// ningun componente ni pedir permisos de administrador. Por eso en las listas
// sale con ese nombre y no como "Nexo". Quien la alimenta es el ayudante
// nativo/camvirtual.cs; OBS no tiene que estar abierto.
//
// Cadena: H.264 del iPhone (tal cual llega por el cable) -> ffmpeg (decodifica,
// gira, refleja, recorta) -> tuberia con nombre -> ayudante -> memoria
// compartida. Es la imagen directa del iPhone, sin los ajustes de color del
// estudio.
//
// El tamano de la camara es el de la imagen que sale de ffmpeg. Una aplicacion
// que ya la tenga abierta conserva el tamano que negocio, y el componente de OBS
// le estira la imagen nueva hasta encajarla: tras cambiar de formato en el
// iPhone, el giro o el encuadre hay que volver a elegir la camara en esa
// aplicacion (medido con TikTok el 05/10/2026).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buscarFfmpeg } = require('./grabador');

const FUENTE = path.join(__dirname, '..', 'nativo', 'camvirtual.cs');
const COMPILADOR = path.join(
  process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'
);

// Delimitador de unidad de acceso. El analizador de ffmpeg no da por terminado
// un fotograma hasta ver empezar el siguiente: sin esto la camara iria siempre
// un fotograma (33 ms) por detras.
const AUD = Buffer.from([0, 0, 0, 1, 0x09, 0xf0]);

// Por encima de 1080p no se publica: un fotograma 4K en NV12 son 12 MB, 370 MB/s
// a 30 fps, y ninguna aplicacion de directo emite a mas de 1080p.
const MAX_PIXELES = 1920 * 1080;

// Si ffmpeg no da abasto se tiran fotogramas hasta la siguiente clave en vez de
// acumular retraso sin limite. El tope deja sitio al grupo entero que se le da
// de golpe al arrancar (2 s de video: unos 2 MB a 720p, 8 MB a 4K).
const MAX_COLA = 16 * 1024 * 1024;

// Tope del grupo guardado: 10 s a 60 fps. Un iPhone manda una clave cada 2 s.
const MAX_GRUPO = 600;

// Lo que tiene que durar un tamano nuevo antes de cambiar el de la camara (ms).
const ASIENTO = 400;

const ENCUADRES = { '1:1': [1, 1], '9:16': [9, 16], '16:9': [16, 9], '4:5': [4, 5] };

const par = (x) => Math.max(2, Math.floor(x / 2) * 2);

// --- Tamano de la imagen que llega ------------------------------------------

// La primera SPS de un fotograma clave, sin el codigo de inicio. Va siempre
// delante de la imagen, asi que solo se recorren unos pocos bytes.
function extraerSps(datos) {
  let inicio = -1;
  for (let i = 0; i + 3 < datos.length; i++) {
    if (datos[i] !== 0 || datos[i + 1] !== 0) continue;
    const largo = datos[i + 2] === 1 ? 3 : datos[i + 2] === 0 && datos[i + 3] === 1 ? 4 : 0;
    if (!largo) continue;
    if (inicio >= 0) return datos.subarray(inicio, i);
    const tipo = datos[i + largo] & 0x1f;
    if (tipo === 7) inicio = i + largo;
    else if (tipo === 1 || tipo === 5) return null; // ya es imagen: no trae SPS
    i += largo;
  }
  return inicio >= 0 ? datos.subarray(inicio) : null;
}

// Ancho y alto de la imagen segun la SPS (H.264, 7.3.2.1.1). Se lee del propio
// flujo y no del estado que publica el movil porque ese llega aparte y puede ir
// unos fotogramas por detras de un cambio de resolucion.
function tamanoDeSps(nal) {
  // Quitar los bytes de prevencion de emulacion (00 00 03 -> 00 00).
  const b = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    b.push(nal[i]);
  }
  let pos = 8; // tras la cabecera de la NAL
  const bit = () => {
    const octeto = b[pos >> 3];
    if (octeto === undefined) throw new Error('SPS truncada');
    return (octeto >> (7 - (pos++ & 7))) & 1;
  };
  const bits = (n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 2 + bit(); return x; };
  const ue = () => { let ceros = 0; while (!bit()) { if (++ceros > 31) throw new Error('SPS invalida'); } return 2 ** ceros - 1 + bits(ceros); };
  const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };

  const perfil = bits(8);
  bits(16); // restricciones y nivel
  ue(); // identificador
  let croma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(perfil)) {
    croma = ue();
    if (croma === 3) bit();
    ue(); ue(); bit();
    if (bit()) {
      for (let i = 0; i < (croma !== 3 ? 8 : 12); i++) {
        if (!bit()) continue;
        let ultimo = 8, siguiente = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (siguiente !== 0) siguiente = (ultimo + se() + 256) % 256;
          ultimo = siguiente === 0 ? ultimo : siguiente;
        }
      }
    }
  }
  ue(); // log2_max_frame_num
  const tipoOrden = ue();
  if (tipoOrden === 0) ue();
  else if (tipoOrden === 1) {
    bit(); se(); se();
    const ciclo = ue();
    for (let i = 0; i < ciclo; i++) se();
  }
  ue(); bit();
  const anchoMb = ue() + 1;
  const altoMapa = ue() + 1;
  const soloCuadros = bit();
  if (!soloCuadros) bit();
  bit();
  let izq = 0, der = 0, arr = 0, aba = 0;
  if (bit()) { izq = ue(); der = ue(); arr = ue(); aba = ue(); }
  const ux = croma === 0 || croma === 3 ? 1 : 2;
  const uy = (croma === 1 ? 2 : 1) * (2 - soloCuadros);
  const ancho = anchoMb * 16 - ux * (izq + der);
  const alto = (2 - soloCuadros) * altoMapa * 16 - uy * (arr + aba);
  if (!(ancho > 0 && alto > 0)) throw new Error('SPS con tamano invalido');
  return { ancho, alto };
}

// --- Que sale por la camara ---------------------------------------------------

// De la imagen que llega y las opciones, el tamano de la camara y los filtros
// de ffmpeg que la producen.
function planificar(origen, { giro = 0, espejo = false, encuadre = null } = {}) {
  const filtros = [];
  let { ancho, alto } = origen;
  if (giro === 90) filtros.push('transpose=1');
  else if (giro === 270) filtros.push('transpose=2');
  else if (giro === 180) filtros.push('hflip', 'vflip');
  if (giro === 90 || giro === 270) [ancho, alto] = [alto, ancho];
  if (espejo) filtros.push('hflip');

  const proporcion = ENCUADRES[encuadre];
  if (proporcion) {
    const [a, b] = proporcion;
    const rw = par(Math.min(ancho, (alto * a) / b));
    const rh = par(Math.min(alto, (ancho * b) / a));
    if (rw !== ancho || rh !== alto) filtros.push(`crop=${rw}:${rh}`);
    ancho = rw;
    alto = rh;
  }

  let w = par(ancho);
  let h = par(alto);
  if (w * h > MAX_PIXELES) {
    const k = Math.sqrt(MAX_PIXELES / (w * h));
    w = par(w * k);
    h = par(h * k);
  }
  if (w !== ancho || h !== alto) filtros.push(`scale=${w}:${h}:flags=bilinear`);
  filtros.push('format=nv12');
  return { ancho: w, alto: h, filtros: filtros.join(',') };
}

// --- La camara ------------------------------------------------------------------

class CamaraVirtual extends EventEmitter {
  // traza: el ayudante avisa de cada fotograma publicado (evento 'traza'). Solo
  // para herramientas/prueba-camara-virtual.js.
  constructor({ carpetaDatos, opciones = {}, registro = console, traza = false } = {}) {
    super();
    this.traza = traza;
    this.exe = path.join(carpetaDatos, 'camvirtual.exe');
    this.copiaFuente = path.join(carpetaDatos, 'camvirtual.cs');
    this.serie = 0; // cada ayudante estrena tuberia: el anterior puede tardar en soltar la suya
    this.opciones = { giro: 0, espejo: false, encuadre: null, ...opciones };
    this.registro = registro;

    this.activa = false;
    this.motivo = null;      // por que no esta saliendo, en palabras para el usuario
    this.fps = 30;
    this.sps = null;         // bytes de la SPS en curso
    this.origen = null;      // { ancho, alto } de lo que manda el iPhone
    this.origenDesde = 0;    // desde cuando manda ese tamano
    this.ayudante = null;    // { proceso, lienzo, listo }
    this.ffmpeg = null;      // { proceso, firma }
    // Lo recibido desde la ultima clave. Al arrancar ffmpeg se le da entero y
    // la imagen sale al momento, en vez de esperar hasta 2 s a la clave siguiente.
    this.grupo = [];
    this.esperandoClave = true;
    this.compilando = null;
    this.reintento = null;
    this.tirados = 0;
  }

  estado() {
    const a = this.ayudante;
    return {
      activa: this.activa,
      enMarcha: Boolean(a && a.listo && this.ffmpeg),
      tamano: a && a.listo ? a.lienzo : null,
      motivo: this.motivo,
      ...this.opciones,
    };
  }

  activar(activa) {
    activa = Boolean(activa);
    if (activa === this.activa) return;
    this.activa = activa;
    this.#motivo(null);
    if (activa) this.#asegurar();
    else this.#apagar();
  }

  // Giro (0, 90, 180, 270), espejo y encuadre ('1:1', '9:16'... o null = completo).
  configurar(opciones) {
    this.opciones = { ...this.opciones, ...opciones };
    this.#asegurar();
  }

  // Cada fotograma de la camara principal: { datos, clave }.
  escribir(v, fps) {
    if (!this.activa) return;
    if (fps) this.fps = fps;

    if (v.clave) {
      const sps = extraerSps(v.datos);
      if (sps && !(this.sps && sps.equals(this.sps))) {
        try {
          this.origen = tamanoDeSps(sps);
          this.origenDesde = Date.now();
          this.sps = Buffer.from(sps);
          this.registro.log(`[camara] el iPhone manda ${this.origen.ancho}x${this.origen.alto}`);
          this.#asegurar();
        } catch (e) {
          this.registro.error('[camara] no entiendo el formato del video:', e.message);
          return;
        }
      }
    }

    const trozo = Buffer.concat([v.datos, AUD]);
    if (v.clave) this.grupo = [trozo];
    else if (this.grupo.length && this.grupo.length < MAX_GRUPO) this.grupo.push(trozo);

    const f = this.ffmpeg;
    if (!f || f.firma !== this.#firma()) return;
    if (this.esperandoClave) {
      if (!v.clave) return;
      this.esperandoClave = false;
    }
    if (f.proceso.stdin.writableLength > MAX_COLA) {
      this.esperandoClave = true;
      this.tirados++;
      return;
    }
    f.proceso.stdin.write(trozo);
  }

  // La sesion con el iPhone se cerro. El ayudante sigue vivo y pone la camara
  // en negro a los 3 s; al volver el video se reengancha en la primera clave.
  cortar() {
    this.sps = null;
    this.origen = null;
    this.grupo = [];
    this.#pararFfmpeg();
  }

  detener() {
    this.activa = false;
    this.#apagar();
  }

  // --- interno ---

  #firma() {
    const o = this.opciones;
    return this.origen
      ? `${this.origen.ancho}x${this.origen.alto}|${o.giro}|${o.espejo ? 1 : 0}|${o.encuadre || ''}`
      : null;
  }

  #motivo(texto) {
    if (texto === this.motivo) return;
    this.motivo = texto;
    if (texto) this.registro.error('[camara] ' + texto);
    this.emit('estado', this.estado());
  }

  #apagar() {
    clearTimeout(this.reintento);
    this.reintento = null;
    this.#pararFfmpeg();
    this.#pararAyudante();
    this.sps = null;
    this.origen = null;
    this.emit('estado', this.estado());
  }

  #pararFfmpeg() {
    const f = this.ffmpeg;
    this.ffmpeg = null;
    this.esperandoClave = true;
    if (!f) return;
    f.proceso.removeAllListeners('exit');
    // Primero matarlo: si viera cerrarse la entrada intentaria decodificar el
    // delimitador suelto del final y lo dejaria en el registro como un error.
    try { f.proceso.kill(); } catch { /* ya habia terminado */ }
    try { f.proceso.stdin.destroy(); } catch { /* ya estaba cerrado */ }
  }

  #pararAyudante() {
    const a = this.ayudante;
    this.ayudante = null;
    if (!a) return;
    a.proceso.removeAllListeners('exit');
    // Cerrarle la entrada, no matarlo: asi marca la camara como parada y las
    // aplicaciones la sueltan. Matado, la dejaria congelada en el ultimo
    // fotograma.
    try { a.proceso.stdin.end(); } catch { /* ya estaba cerrado */ }
    setTimeout(() => { try { a.proceso.kill(); } catch { /* ya habia terminado */ } }, 2000).unref();
  }

  #reintentar(ms) {
    clearTimeout(this.reintento);
    this.reintento = setTimeout(() => { this.reintento = null; this.#asegurar(); }, ms);
    this.reintento.unref();
  }

  // Lleva lo que hay hacia lo que deberia haber. Se llama cada vez que algo
  // cambia (llega una SPS nueva, el ayudante esta listo, un proceso termina,
  // cambian las opciones) y da un paso; el siguiente lo dispara el propio cambio.
  #asegurar() {
    if (!this.activa || !this.origen || this.reintento) return;
    const ffmpeg = buscarFfmpeg();
    if (!ffmpeg) return this.#motivo('falta ffmpeg: sin el no hay camara');

    const plan = planificar(this.origen, this.opciones);
    const lienzo = `${plan.ancho}x${plan.alto}`;

    if (this.ayudante && this.ayudante.lienzo !== lienzo) {
      // Al arrancar o cambiar de formato, Nexo Cam manda unos fotogramas con el
      // tamano sin girar antes del definitivo (3840x2160, 2160x3840 y vuelta, en
      // 1 s; visto el 05/10/2026). Se espera a que se asiente para no cerrar y
      // abrir la camara tres veces seguidas.
      const falta = ASIENTO - (Date.now() - this.origenDesde);
      if (falta > 0) return this.#reintentar(falta);
      this.#pararFfmpeg();
      this.#pararAyudante();
    }
    if (!this.ayudante) return this.#arrancarAyudante(plan, lienzo);
    if (!this.ayudante.listo) return;

    const firma = this.#firma();
    if (this.ffmpeg && this.ffmpeg.firma !== firma) this.#pararFfmpeg();
    if (!this.ffmpeg) this.#arrancarFfmpeg(ffmpeg, plan, firma);
  }

  // El .exe no viaja en el repositorio: se compila con el csc.exe de Windows la
  // primera vez, y otra vez si cambia la fuente.
  #compilar() {
    if (this.compilando) return this.compilando;
    this.compilando = new Promise((ok, mal) => {
      let fuente;
      try {
        fuente = fs.readFileSync(FUENTE);
        if (fs.existsSync(this.exe) && fs.readFileSync(this.copiaFuente).equals(fuente)) return ok();
      } catch { /* sin copia o sin exe: toca compilar */ }
      if (!fuente) return mal(new Error('no encuentro ' + FUENTE));
      if (!fs.existsSync(COMPILADOR)) return mal(new Error('no encuentro el compilador de Windows (csc.exe)'));
      try {
        fs.mkdirSync(path.dirname(this.exe), { recursive: true });
        fs.writeFileSync(this.copiaFuente, fuente);
      } catch (e) {
        return mal(e);
      }
      let salida = '';
      const p = spawn(COMPILADOR, ['-nologo', '-optimize', `-out:${this.exe}`, this.copiaFuente]);
      p.stdout.on('data', (d) => { salida += d; });
      p.stderr.on('data', (d) => { salida += d; });
      p.on('error', mal);
      p.on('exit', (codigo) => {
        if (codigo === 0) return ok();
        try { fs.unlinkSync(this.copiaFuente); } catch { /* da igual */ }
        mal(new Error('no se pudo compilar el ayudante: ' + salida.trim().split('\n')[0]));
      });
    }).finally(() => { this.compilando = null; });
    return this.compilando;
  }

  #arrancarAyudante(plan, lienzo) {
    const a = { proceso: null, lienzo, listo: false, tuberia: `nexo-camvirtual-${process.pid}-${++this.serie}` };
    this.ayudante = a;
    this.#compilar().then(() => {
      if (this.ayudante !== a) return; // se apago o cambio mientras compilaba
      const args = [plan.ancho, plan.alto, this.fps, a.tuberia].map(String);
      if (this.traza) args.push('traza');
      const p = spawn(this.exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      a.proceso = p;
      p.stdin.on('error', () => {});
      p.stderr.on('data', (d) => this.registro.error('[camara] ayudante:', d.toString().trim()));
      let resto = '';
      p.stdout.on('data', (d) => {
        const lineas = (resto + d).split(/\r?\n/);
        resto = lineas.pop();
        for (const linea of lineas) this.#lineaAyudante(a, linea);
      });
      p.on('error', (e) => {
        if (this.ayudante !== a) return;
        this.ayudante = null;
        this.#motivo('no se pudo abrir la camara: ' + e.message);
        this.#reintentar(10000);
      });
      p.on('exit', (codigo) => {
        if (this.ayudante !== a) return;
        this.ayudante = null;
        this.#pararFfmpeg();
        if (codigo === 3) {
          this.#motivo('otra aplicacion ya usa la camara virtual (¿la de OBS esta iniciada?)');
          this.#reintentar(10000);
        } else {
          this.registro.error('[camara] el ayudante termino solo, codigo', codigo);
          this.#reintentar(2000);
        }
        this.emit('estado', this.estado());
      });
    }).catch((e) => {
      if (this.ayudante !== a) return;
      this.ayudante = null;
      this.#motivo(e.message);
      this.#reintentar(30000);
    });
  }

  #lineaAyudante(a, linea) {
    if (linea.startsWith('lista')) {
      a.listo = true;
      this.#motivo(null);
      this.registro.log(`[camara] "OBS Virtual Camera" lista a ${a.lienzo}`);
      this.emit('estado', this.estado());
      this.#asegurar();
    } else if (linea.startsWith('f ')) {
      const [, numero, ms] = linea.split(' ');
      this.emit('traza', { numero: Number(numero), ms: Number(ms) });
    } else if (linea.startsWith('t ')) {
      // Misma idea que la telemetria `[video] obs:`: sin medir no se sabe si va fluido.
      const [, fotogramas, hueco] = linea.split(' ');
      const tirados = this.tirados ? `, ${this.tirados} tirados por atasco` : '';
      this.tirados = 0;
      this.registro.log(`[camara] virtual: ${fotogramas} fotogramas en 5 s, hueco max ${hueco} ms${tirados}`);
    }
  }

  #arrancarFfmpeg(ffmpeg, plan, firma) {
    // Un solo hilo mientras la imagen sea de hasta 1080p: los hilos por
    // fotograma de ffmpeg retrasan la salida un fotograma por hilo (7 hilos,
    // 233 ms a 30 fps). Por encima no da abasto con uno y se acepta el retraso.
    const hilos = this.origen.ancho * this.origen.alto > MAX_PIXELES ? '4' : '1';
    const p = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      // Arranque sin analizar el flujo: por defecto ffmpeg lee varios segundos
      // antes de dar el primer fotograma. Ojo con dos opciones que parecen
      // ayudar y hacen lo contrario (medido el 05/10/2026): "-fflags nobuffer"
      // tira lo leido al analizar (se perdian los 60 primeros fotogramas) y
      // "-analyzeduration 0" significa "el valor por defecto", 5 s.
      '-flags', 'low_delay',
      '-probesize', '32', '-analyzeduration', '1', '-fpsprobesize', '0',
      '-threads', hilos,
      '-f', 'h264', '-i', 'pipe:0',
      '-an', '-vf', plan.filtros,
      // Cada fotograma sale segun se decodifica, sin que ffmpeg lo reparta en
      // el tiempo: el ritmo ya lo marca el iPhone.
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-y', `\\\\.\\pipe\\${this.ayudante.tuberia}`,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const f = { proceso: p, firma };
    this.ffmpeg = f;
    p.stdin.on('error', () => {});
    // Lo que ya se tenia desde la ultima clave: la imagen sale sin esperar.
    this.esperandoClave = this.grupo.length === 0;
    for (const trozo of this.grupo) p.stdin.write(trozo);
    p.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) this.registro.error('[camara] ffmpeg:', t.split('\n')[0]);
    });
    p.on('error', (e) => {
      if (this.ffmpeg !== f) return;
      this.ffmpeg = null;
      this.#motivo('no se pudo lanzar ffmpeg: ' + e.message);
      this.#reintentar(10000);
    });
    p.on('exit', () => {
      if (this.ffmpeg !== f) return;
      this.ffmpeg = null;
      this.esperandoClave = true;
      this.#reintentar(500);
      this.emit('estado', this.estado());
    });
    this.emit('estado', this.estado());
  }
}

module.exports = { CamaraVirtual, planificar, extraerSps, tamanoDeSps, ENCUADRES };
