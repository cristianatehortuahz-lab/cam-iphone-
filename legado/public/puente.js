'use strict';

// Puente entre Nexo Desktop (Electron) y el estudio. Solo se activa si
// window.nexo esta presente, es decir, cuando la pagina corre dentro de la
// app nativa. En navegador plano no hace nada, el modo WebRTC sigue igual.
//
// Cuando llega vídeo del iPhone por el transporte nativo:
//   1. Se decodifica H.264 → VideoFrame con WebCodecs
//   2. Cada VideoFrame se entrega al procesador de color como frame externo
//   3. El procesador lo sube a la textura y lo pinta con los ajustes de imagen
//
// Comparte procesador/viewer con la ruta WebRTC del navegador: los deslizadores
// de color, la captura, la grabacion y OBS siguen funcionando igual.

(function iniciar() {
  if (!window.nexo || typeof window.nexo.onVideo !== 'function') return; // navegador plano

  // El decodificador y el procesador se crean en viewer.js. Este puente les da
  // los VideoFrame que llegan del iPhone. viewer.js expone `procesador` y crea
  // un decodificador al detectar la ruta nativa.
  if (typeof DecodificadorVideo === 'undefined') {
    console.error('[puente] decodificador.js no esta cargado');
    return;
  }

  let primerFrame = true;
  // Ultimo estado del iPhone (lentes, zoom, bateria...). Se guarda porque puede
  // llegar antes de que el estudio este listo para pintarlo.
  let ultimoEstado = null;

  function pintarEstado(estado) {
    if (!estado) return;
    ultimoEstado = estado;
    // Solo se pinta con la ruta nativa ya activa: antes, habilitarControles()
    // aun no ha corrido y pintarEstadoMovil dejaria el desplegable a medias.
    if (window.nexoNativoActivo && window.pintarEstadoMovil) {
      window.pintarEstadoMovil(estado);
    }
  }

  const decodificador = new DecodificadorVideo({
    onFrame: (frame) => {
      // El procesador cierra el frame despues de usarlo (los VideoFrame son
      // recursos de GPU y hay que liberarlos cuanto antes).
      const proc = window.procesador;
      if (!proc) { frame.close(); return; }

      // El frame va SIEMPRE antes de iniciar(). El bucle de dibujo mira
      // `frameExterno` para decidir como reprogramarse, y si arranca sin
      // ninguno se engancha al requestVideoFrameCallback del <video>, que en
      // modo nativo no tiene fuente y no se dispara nunca: el bucle moria en la
      // primera vuelta y el lienzo se quedaba en negro con el video llegando.
      // Las medidas se leen ANTES de entregarlo: el procesador lo sube a la
      // textura y lo cierra, y un VideoFrame cerrado mide 0x0.
      const ancho = frame.displayWidth;
      const alto = frame.displayHeight;

      proc.ponerFrameExterno(frame);

      if (primerFrame) {
        // Primer VideoFrame del iPhone: la ruta nativa toma el mando. La marca
        // le dice a viewer.js que no desmonte el estudio cuando la senalizacion
        // WebRTC diga que no hay movil (por cable nunca lo hay: el iPhone no se
        // registra en el WebSocket).
        window.nexoNativoActivo = true;
        proc.iniciar();
        const esp = document.getElementById('espera');
        if (esp) esp.classList.add('oculto');
        // Sin esto los controles siguen deshabilitados desde el arranque: por
        // cable nadie llama a habilitarControles(), porque eso lo hacia la ruta
        // WebRTC al recibir su pista de video.
        if (window.habilitarControles) window.habilitarControles(true);
        pintarEstado(ultimoEstado);
        primerFrame = false;
        console.log('[puente] primer fotograma en pantalla: ' + ancho + 'x' + alto);
      }
    },
    onError: (e) => console.error('[puente] decoder:', e.message || e),
  });

  window.nexo.onVideo((v) => {
    // v = { microsegundos, clave, datos: Buffer|Uint8Array }
    const datos = v.datos instanceof Uint8Array
      ? v.datos
      : new Uint8Array(v.datos.buffer || v.datos, v.datos.byteOffset || 0, v.datos.length || v.datos.byteLength);
    decodificador.decodificar(datos, v.microsegundos, v.clave);
  });

  // Traduce el estado del transporte nativo a algo util en la pantalla de
  // espera. Antes siempre decia "conecta el iPhone por el cable" aunque el
  // cable estuviera puesto y el movil detectado, que es justo cuando mas
  // desorienta: el problema real suele ser que Nexo Cam no esta abierta o que
  // le falta el permiso de camara (sin el, la app no abre su puerto).
  function pintarEstadoCable(estado) {
    const el = document.getElementById('estadoCable');
    if (!el || !estado) return;
    let texto = null;
    let bien = false;

    if (estado.conectado) {
      texto = `iPhone conectado por ${estado.origen}. Recibiendo video…`;
      bien = true;
    } else if (estado.hayCable) {
      texto =
        'iPhone detectado por el cable, pero Nexo Cam no responde. ' +
        'Abrela en el movil y dejala en pantalla. Si ya lo esta, revisa ' +
        'Ajustes › Nexo › Camara: sin ese permiso la app no abre su puerto.';
    } else if (estado.hayUsbmux === false) {
      texto =
        'No encuentro el servicio de Apple. Instala iTunes o Apple Devices, ' +
        'o vuelve a conectar el iPhone.';
    } else {
      texto = 'Sin iPhone por cable. Conectalo con el USB-C y desbloquealo.';
    }

    el.textContent = texto;
    el.classList.toggle('bien', bien);
    el.classList.remove('oculto');
  }

  // --- Audio -----------------------------------------------------------
  //
  // El iPhone manda AAC en ADTS (cada paquete con su cabecera, decodificable por
  // si solo). Se decodifica con WebCodecs y se vuelca en un nodo de destino, que
  // da una pista de audio normal: asi la grabacion puede mezclarla con el video
  // del lienzo sin que el resto del estudio se entere de nada.
  //
  // Si algo de esto falla, el video sigue igual: el audio es un extra.
  let audioCtx = null;
  let destinoAudio = null;
  let decoAudio = null;
  let proximoInicio = 0;

  function prepararAudio() {
    if (audioCtx || typeof AudioDecoder === 'undefined') return;
    try {
      audioCtx = new AudioContext();
      destinoAudio = audioCtx.createMediaStreamDestination();
      // viewer.js la busca aqui al empezar a grabar.
      window.nexoPistaAudio = destinoAudio.stream.getAudioTracks()[0] || null;

      decoAudio = new AudioDecoder({
        output: (datos) => {
          try { reproducir(datos); } finally { datos.close(); }
        },
        error: (e) => console.error('[puente] audio:', e.message || e),
      });
      // mp4a.40.2 = AAC-LC. La tasa y los canales los fija el iPhone.
      decoAudio.configure({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1 });
      console.log('[puente] audio listo');
    } catch (e) {
      console.error('[puente] no se pudo preparar el audio:', e.message || e);
      audioCtx = null;
    }
  }

  function reproducir(datos) {
    if (!audioCtx || !destinoAudio) return;
    const canales = datos.numberOfChannels;
    const buffer = audioCtx.createBuffer(canales, datos.numberOfFrames, datos.sampleRate);
    for (let c = 0; c < canales; c++) {
      const trozo = new Float32Array(datos.numberOfFrames);
      datos.copyTo(trozo, { planeIndex: c, format: 'f32-planar' });
      buffer.copyToChannel(trozo, c);
    }
    const fuente = audioCtx.createBufferSource();
    fuente.buffer = buffer;
    fuente.connect(destinoAudio);
    // Se encadenan uno detras de otro. Si nos quedamos atras (la red se atasco),
    // se reengancha al presente en vez de acumular retraso indefinidamente.
    const ahora = audioCtx.currentTime;
    if (proximoInicio < ahora) proximoInicio = ahora + 0.02;
    fuente.start(proximoInicio);
    proximoInicio += buffer.duration;
  }

  if (typeof window.nexo.onAudio === 'function') {
    window.nexo.onAudio((a) => {
      prepararAudio();
      if (!decoAudio || decoAudio.state !== 'configured') return;
      const datos = a.datos instanceof Uint8Array
        ? a.datos
        : new Uint8Array(a.datos.buffer || a.datos, a.datos.byteOffset || 0, a.datos.length || a.datos.byteLength);
      try {
        decoAudio.decode(new EncodedAudioChunk({
          type: 'key', timestamp: a.microsegundos, data: datos,
        }));
      } catch (e) {
        console.error('[puente] audio:', e.message || e);
      }
    });
  }

  window.nexo.onConexion((c) => {
    if (c && c.estado) { pintarEstadoCable(c.estado); pintarCamaras(c.estado); }

    // Cuando la sesion se cierra, resetear el decodificador: la proxima vez
    // empezara por un nuevo fotograma clave.
    if (c.evento === 'sesion-cerrada') {
      decodificador.cerrar();
      // Se devuelve el mando a la ruta WebRTC y se vuelve a mostrar la espera.
      window.nexoNativoActivo = false;
      primerFrame = true;
      const esp = document.getElementById('espera');
      if (esp) esp.classList.remove('oculto');
    }
    // El iPhone publica lentes, zoom, bateria... por el transporte nativo, no
    // por el WebSocket, asi que hay que llevarlo a mano a la interfaz.
    if (c.evento === 'estado-movil') pintarEstado(c.datos);

    // Publicar el estado para que viewer.js pueda mostrarlo (icono en la UI).
    window.dispatchEvent(new CustomEvent('nexo:conexion', { detail: c }));
  });

  // El iPhone publica su estado al conectar y luego solo cuando algo cambia. Si
  // esa primera vez ocurrio antes de que existiera esta pagina, el proceso
  // principal lo tiene guardado: se recupera al arrancar.
  if (typeof window.nexo.estado === 'function') {
    window.nexo.estado().then((e) => {
      if (e && e.conexion) { pintarEstadoCable(e.conexion); pintarCamaras(e.conexion); }
      if (e && e.conexion && e.conexion.estadoMovil) pintarEstado(e.conexion.estadoMovil);
    }).catch(() => {});
  }

  // --- Camaras y grabacion ---------------------------------------------
  //
  // La grabacion ya no vive aqui: la hace el proceso principal, que copia los
  // fotogramas a disco sin recodificar y sigue aunque la ventana este
  // minimizada. Esto es solo el mando.
  const elTira = document.getElementById('tiraCamaras');
  const elGrupoCamaras = document.getElementById('grupoCamaras');
  const elEstadoGrab = document.getElementById('estadoGrabacion');

  function pintarCamaras(estado) {
    if (!elTira || !estado || !estado.camaras) return;
    const camaras = estado.camaras;
    // Con una sola camara no hay nada que elegir.
    if (elGrupoCamaras) elGrupoCamaras.classList.toggle('oculto', camaras.length < 2);

    const firma = camaras.map((c) => c.id + ':' + c.principal).join('|');
    if (firma === elTira.dataset.firma) return;
    elTira.dataset.firma = firma;

    elTira.innerHTML = '';
    camaras.forEach((c, i) => {
      const b = document.createElement('button');
      const modelo = (c.estadoMovil && c.estadoMovil.resolucionReal) || '';
      b.textContent = `Camara ${i + 1}${modelo ? ' · ' + modelo : ''}`;
      b.classList.toggle('activa', c.principal);
      b.addEventListener('click', () => window.nexo.elegirPrincipal(c.id));
      elTira.appendChild(b);
    });
  }

  function pintarGrabacion(g) {
    if (!elEstadoGrab || !g) return;
    const boton = document.getElementById('grabar');
    if (g.grabando) {
      const m = Math.floor(g.segundos / 60);
      const seg = String(g.segundos % 60).padStart(2, '0');
      elEstadoGrab.textContent = `Grabando ${g.pistas.length} camara(s) · ${m}:${seg}`;
      elEstadoGrab.classList.add('grabando');
      if (boton) { boton.textContent = 'Detener'; boton.classList.add('activo'); }
    } else {
      elEstadoGrab.textContent = g.ffmpeg
        ? 'Sin grabar'
        : 'Sin grabar · sin ffmpeg se guardara el flujo crudo';
      elEstadoGrab.classList.remove('grabando');
      if (boton) { boton.textContent = 'Grabar'; boton.classList.remove('activo'); }
    }
  }

  // El estudio pide grabar y el proceso principal lo hace.
  window.nexoGrabar = async () => {
    const estado = await window.nexo.estadoGrabacion();
    const r = estado.grabando ? await window.nexo.pararGrabacion() : await window.nexo.grabar();
    if (!r.ok && r.motivo) console.warn('[puente] grabacion:', r.motivo);
    pintarGrabacion(await window.nexo.estadoGrabacion());
    return r;
  };

  if (typeof window.nexo.onGrabacion === 'function') window.nexo.onGrabacion(pintarGrabacion);

  // El cronometro lo lleva el proceso principal; aqui solo se refresca.
  setInterval(async () => {
    try { pintarGrabacion(await window.nexo.estadoGrabacion()); } catch {}
  }, 1000);

  const btnCarpeta = document.getElementById('carpetaBtn');
  if (btnCarpeta) btnCarpeta.addEventListener('click', () => window.nexo.elegirCarpeta());
  const btnAbrir = document.getElementById('abrirCarpetaBtn');
  if (btnAbrir) btnAbrir.addEventListener('click', () => window.nexo.abrirCarpeta());

  console.log('[puente] activo (modo nativo: transporte Nexo → procesador)');
})();
