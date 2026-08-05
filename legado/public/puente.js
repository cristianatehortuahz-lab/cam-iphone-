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
  const decodificador = new DecodificadorVideo({
    onFrame: (frame) => {
      // El procesador cierra el frame despues de usarlo (los VideoFrame son
      // recursos de GPU y hay que liberarlos cuanto antes).
      const proc = window.procesador;
      if (!proc) { frame.close(); return; }
      if (primerFrame) {
        // Cuando llega el primer VideoFrame del iPhone: arrancamos el bucle de
        // dibujo (si no lo estaba) y ocultamos la pantalla de espera de WebRTC.
        proc.iniciar();
        const esp = document.getElementById('espera');
        if (esp) esp.classList.add('oculto');
        primerFrame = false;
      }
      proc.ponerFrameExterno(frame);
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
    if (c.evento === 'sesion-cerrada') decodificador.cerrar();
    // Publicar el estado para que viewer.js pueda mostrarlo (icono en la UI).
    window.dispatchEvent(new CustomEvent('nexo:conexion', { detail: c }));
  });

  console.log('[puente] activo (modo nativo: transporte Nexo → procesador)');
})();
