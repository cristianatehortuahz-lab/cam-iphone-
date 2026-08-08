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

  window.nexo.onConexion((c) => {
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
      if (e && e.conexion && e.conexion.estadoMovil) pintarEstado(e.conexion.estadoMovil);
    }).catch(() => {});
  }

  console.log('[puente] activo (modo nativo: transporte Nexo → procesador)');
})();
