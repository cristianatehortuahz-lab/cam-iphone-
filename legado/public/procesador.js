'use strict';

// Motor de correccion de imagen. Toma el video que llega del iPhone, lo procesa
// en la GPU con un shader y lo pinta en un lienzo. Todo lo que se ve (estudio,
// captura, grabacion y salida a OBS) sale de ese lienzo, asi que lo que ajustas
// es exactamente lo que se emite.

const AJUSTES_NEUTROS = {
  exposicion: 0, // pasos de diafragma
  brillo: 0,
  contraste: 1,
  saturacion: 1,
  vibrancia: 0,
  temperatura: 0, // negativo = frio, positivo = calido
  tinte: 0, // negativo = magenta, positivo = verde
  gamma: 1,
  sombras: 0,
  luces: 0,
  nitidez: 0,
  desenfoque: 0,
  vineta: 0,
  espejo: false,
  rotacion: 0,
};

// Rango valido de cada control. Es la fuente unica: el shader lo usa para
// recortar los valores que entran (por localStorage corrupto o por la red), y
// el panel del estudio lo lee para poner los limites de los deslizadores. Asi
// un NaN o un numero disparatado no puede dejar la salida en negro.
const RANGOS = {
  exposicion: { min: -2, max: 2 },
  brillo: { min: -0.3, max: 0.3 },
  contraste: { min: 0.5, max: 2 },
  saturacion: { min: 0, max: 2 },
  vibrancia: { min: -0.5, max: 1 },
  temperatura: { min: -0.4, max: 0.4 },
  tinte: { min: -0.3, max: 0.3 },
  sombras: { min: -0.2, max: 0.3 },
  luces: { min: -0.3, max: 0.2 },
  gamma: { min: 0.5, max: 2 },
  nitidez: { min: 0, max: 1 },
  desenfoque: { min: 0, max: 2 },
  vineta: { min: 0, max: 1 },
};

// Puntos de partida habituales. No son destinos, son atajos: se ajustan encima.
const PRESETES = {
  neutro: {},
  calido: { temperatura: 0.12, saturacion: 1.08, sombras: 0.02, contraste: 1.05 },
  frio: { temperatura: -0.12, saturacion: 1.05, contraste: 1.08 },
  vivido: { saturacion: 1.25, vibrancia: 0.3, contraste: 1.15, nitidez: 0.4 },
  suave: { contraste: 0.92, sombras: 0.06, luces: -0.04, saturacion: 0.95, nitidez: 0.15 },
  cine: { contraste: 1.12, saturacion: 0.9, temperatura: -0.05, sombras: 0.05, luces: -0.06, vineta: 0.25 },
  retrato: { saturacion: 1.05, vibrancia: 0.2, sombras: 0.04, luces: -0.03, nitidez: 0.25, temperatura: 0.05 },
  byn: { saturacion: 0, contraste: 1.18, nitidez: 0.35 },
  nocturno: { exposicion: 0.6, sombras: 0.12, gamma: 1.15, nitidez: 0.2, saturacion: 0.95 },
};

const VERTICE = `
attribute vec2 a_pos;
uniform mat2 u_giro;
uniform vec2 u_escala;
uniform float u_espejo;
varying vec2 v_uv;
void main() {
  // El quad va de -1 a 1; giramos, recortamos y reflejamos aqui las coordenadas
  // de textura para no gastar una pasada extra solo en orientar la imagen.
  vec2 uv = u_giro * a_pos;
  uv *= u_escala; // recorte al formato de salida, en el espacio de la fuente
  uv.x *= u_espejo;
  v_uv = uv * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENTO = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_exposicion, u_brillo, u_contraste, u_saturacion, u_vibrancia;
uniform float u_temperatura, u_tinte, u_gamma, u_sombras, u_luces;
uniform float u_nitidez, u_desenfoque, u_vineta;
varying vec2 v_uv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec2 uv = clamp(v_uv, 0.0, 1.0);
  vec3 c = texture2D(u_tex, uv).rgb;

  // Desenfoque suave en cruz: util para disimular ruido con poca luz.
  if (u_desenfoque > 0.0) {
    vec2 d = u_texel * u_desenfoque;
    vec3 suma = texture2D(u_tex, uv + vec2(-d.x, 0.0)).rgb
              + texture2D(u_tex, uv + vec2( d.x, 0.0)).rgb
              + texture2D(u_tex, uv + vec2(0.0, -d.y)).rgb
              + texture2D(u_tex, uv + vec2(0.0,  d.y)).rgb
              + texture2D(u_tex, uv + d).rgb
              + texture2D(u_tex, uv - d).rgb;
    c = mix(c, suma / 6.0, clamp(u_desenfoque, 0.0, 1.0));
  }

  // Nitidez por mascara de enfoque: restamos una version borrosa y devolvemos
  // la diferencia amplificada. Es lo que hace que la piel y el pelo "canten".
  if (u_nitidez > 0.0) {
    vec3 borroso = (texture2D(u_tex, uv + vec2(-u_texel.x, 0.0)).rgb
                  + texture2D(u_tex, uv + vec2( u_texel.x, 0.0)).rgb
                  + texture2D(u_tex, uv + vec2(0.0, -u_texel.y)).rgb
                  + texture2D(u_tex, uv + vec2(0.0,  u_texel.y)).rgb) * 0.25;
    c += (c - borroso) * u_nitidez * 2.0;
  }

  // Exposicion en pasos, como en una camara real.
  c *= pow(2.0, u_exposicion);

  // Temperatura y tinte: balance de blancos manual.
  c.r *= 1.0 + u_temperatura;
  c.b *= 1.0 - u_temperatura;
  c.g *= 1.0 + u_tinte;

  // Sombras y luces por separado, sin tocar los medios tonos.
  float l = dot(c, LUMA);
  c += u_sombras * (1.0 - smoothstep(0.0, 0.55, l));
  c += u_luces * smoothstep(0.45, 1.0, l);

  c += u_brillo;
  c = (c - 0.5) * u_contraste + 0.5;

  // Saturacion plana, y despues vibrancia, que sube solo los colores apagados
  // y por eso respeta mucho mejor los tonos de piel.
  float gris = dot(c, LUMA);
  c = mix(vec3(gris), c, u_saturacion);
  if (u_vibrancia != 0.0) {
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(dot(c, LUMA)), c, 1.0 + u_vibrancia * (1.0 - clamp(sat, 0.0, 1.0)));
  }

  c = pow(max(c, 0.0), vec3(1.0 / u_gamma));

  if (u_vineta > 0.0) {
    vec2 p = v_uv - 0.5;
    c *= 1.0 - u_vineta * clamp(dot(p, p) * 2.2, 0.0, 1.0);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

class ProcesadorImagen {
  constructor(video) {
    this.video = video;
    this.frameExterno = null; // VideoFrame que puede sustituir a this.video
    this.ajustes = { ...AJUSTES_NEUTROS };
    // Proporcion de salida (por ejemplo 9/16). Con null se entrega el fotograma
    // completo. Recortar aqui, y no en CSS, hace que el lienzo tenga ya las
    // dimensiones finales: lo que graba OBS es exactamente lo que se ve.
    this.recorte = null;
    this.canvas = document.createElement('canvas');
    this.activo = false;
    this.gl = null;
    this.pendiente = null;

    const opciones = { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true };
    this.gl = this.canvas.getContext('webgl', opciones) || this.canvas.getContext('experimental-webgl', opciones);
    if (this.gl) this.#prepararGl();
  }

  get disponible() {
    return Boolean(this.gl && this.programa);
  }

  #compilar(tipo, fuente) {
    const gl = this.gl;
    const s = gl.createShader(tipo);
    gl.shaderSource(s, fuente);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Error al compilar el shader:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  #prepararGl() {
    const gl = this.gl;
    const v = this.#compilar(gl.VERTEX_SHADER, VERTICE);
    const f = this.#compilar(gl.FRAGMENT_SHADER, FRAGMENTO);
    if (!v || !f) return;

    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('Error al enlazar el programa:', gl.getProgramInfoLog(p));
      return;
    }
    this.programa = p;
    gl.useProgram(p);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.textura = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.textura);
    // El video no tiene lados potencia de dos: sin CLAMP_TO_EDGE y sin mipmaps
    // WebGL devolveria negro.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.u = {};
    for (const nombre of [
      'u_tex', 'u_texel', 'u_exposicion', 'u_brillo', 'u_contraste', 'u_saturacion',
      'u_vibrancia', 'u_temperatura', 'u_tinte', 'u_gamma', 'u_sombras', 'u_luces',
      'u_nitidez', 'u_desenfoque', 'u_vineta', 'u_giro', 'u_espejo', 'u_escala',
    ]) {
      this.u[nombre] = gl.getUniformLocation(p, nombre);
    }
  }

  // Deja pasar solo lo valido: claves conocidas, numeros finitos recortados a
  // su rango, rotacion en 0/90/180/270 y espejo booleano. Todo lo demas se
  // descarta. Un unico punto cubre las dos entradas: el panel del estudio y los
  // ajustes que llegan por WebSocket desde otro visor.
  sanear(valores) {
    const limpio = {};
    for (const [clave, v] of Object.entries(valores || {})) {
      if (clave === 'espejo') {
        limpio.espejo = Boolean(v);
      } else if (clave === 'rotacion') {
        const r = Number(v);
        if (r === 0 || r === 90 || r === 180 || r === 270) limpio.rotacion = r;
      } else if (Object.prototype.hasOwnProperty.call(RANGOS, clave)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          limpio[clave] = Math.min(RANGOS[clave].max, Math.max(RANGOS[clave].min, n));
        }
      }
    }
    return limpio;
  }

  aplicar(nuevos) {
    Object.assign(this.ajustes, this.sanear(nuevos));
  }

  reiniciar() {
    this.ajustes = { ...AJUSTES_NEUTROS };
  }

  iniciar() {
    if (this.activo || !this.disponible) return;
    this.activo = true;
    this.#bucle();
  }

  parar() {
    this.activo = false;
    if (this.pendiente) cancelAnimationFrame(this.pendiente);
    this.pendiente = null;
  }

  #bucle() {
    if (!this.activo) return;
    this.dibujar();
    // requestVideoFrameCallback dibuja una vez por fotograma real del video, sin
    // repetir trabajo cuando la pantalla va mas rapida que la camara. En la
    // ruta nativa (VideoFrame externo) usamos requestAnimationFrame: cada nuevo
    // frame llega por ponerFrameExterno y se dibuja aqui.
    if (!this.frameExterno && this.video.requestVideoFrameCallback) {
      this.video.requestVideoFrameCallback(() => this.#bucle());
    } else {
      this.pendiente = requestAnimationFrame(() => this.#bucle());
    }
  }

  // Cuando llega vídeo por la ruta nativa (Nexo Cam), el orquestador entrega
  // VideoFrame decodificados. Se usan como fuente en el próximo dibujo y luego
  // se liberan (los VideoFrame consumen memoria de GPU y hay que cerrarlos).
  ponerFrameExterno(vf) {
    if (this.frameExterno) this.frameExterno.close();
    this.frameExterno = vf;
  }

  dibujar() {
    const gl = this.gl;
    const v = this.video;
    const vf = this.frameExterno;

    // Fuente: preferimos el VideoFrame externo si hay; si no, el <video>.
    const fuente = vf || v;
    const anchoFuente = vf ? vf.displayWidth : v.videoWidth;
    const altoFuente = vf ? vf.displayHeight : v.videoHeight;
    const listo = vf || (v.videoWidth && v.readyState >= 2);
    if (!gl || !this.programa || !listo) return;

    const girado = this.ajustes.rotacion === 90 || this.ajustes.rotacion === 270;
    let ancho = girado ? altoFuente : anchoFuente;
    let alto = girado ? anchoFuente : altoFuente;

    // Recorte centrado a la proporcion pedida. Las fracciones se calculan en el
    // espacio de salida y se pasan al de la fuente, que estan intercambiados
    // cuando la imagen va girada 90 o 270 grados.
    let fx = 1;
    let fy = 1;
    if (this.recorte && this.recorte > 0) {
      const proporcion = ancho / alto;
      if (proporcion > this.recorte) {
        fx = this.recorte / proporcion;
        ancho = Math.round(alto * this.recorte);
      } else {
        fy = proporcion / this.recorte;
        alto = Math.round(ancho / this.recorte);
      }
    }
    const escala = girado ? [fy, fx] : [fx, fy];

    if (this.canvas.width !== ancho || this.canvas.height !== alto) {
      this.canvas.width = ancho;
      this.canvas.height = alto;
    }

    gl.viewport(0, 0, ancho, alto);
    gl.useProgram(this.programa);
    gl.bindTexture(gl.TEXTURE_2D, this.textura);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, fuente);
    } catch {
      return; // fotograma aun no disponible
    }

    // Los VideoFrame son de un solo uso: se cierran despues de subirlos.
    if (vf) {
      vf.close();
      this.frameExterno = null;
    }

    const a = this.ajustes;
    const rad = (a.rotacion * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sen = Math.sin(rad);

    gl.uniform1i(this.u.u_tex, 0);
    gl.uniform2f(this.u.u_texel, 1 / anchoFuente, 1 / altoFuente);
    gl.uniformMatrix2fv(this.u.u_giro, false, [cos, sen, -sen, cos]);
    gl.uniform2f(this.u.u_escala, escala[0], escala[1]);
    gl.uniform1f(this.u.u_espejo, a.espejo ? -1 : 1);
    gl.uniform1f(this.u.u_exposicion, a.exposicion);
    gl.uniform1f(this.u.u_brillo, a.brillo);
    gl.uniform1f(this.u.u_contraste, a.contraste);
    gl.uniform1f(this.u.u_saturacion, a.saturacion);
    gl.uniform1f(this.u.u_vibrancia, a.vibrancia);
    gl.uniform1f(this.u.u_temperatura, a.temperatura);
    gl.uniform1f(this.u.u_tinte, a.tinte);
    gl.uniform1f(this.u.u_gamma, Math.max(0.1, a.gamma));
    gl.uniform1f(this.u.u_sombras, a.sombras);
    gl.uniform1f(this.u.u_luces, a.luces);
    gl.uniform1f(this.u.u_nitidez, a.nitidez);
    gl.uniform1f(this.u.u_desenfoque, a.desenfoque);
    gl.uniform1f(this.u.u_vineta, a.vineta);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

window.AJUSTES_NEUTROS = AJUSTES_NEUTROS;
window.RANGOS = RANGOS;
window.PRESETES = PRESETES;
window.ProcesadorImagen = ProcesadorImagen;
