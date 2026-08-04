'use strict';

// Logo maestro de Nexo, en codigo. Todo se deriva de aqui: iconos de Windows,
// catalogo de iOS, pantalla de carga y graficos del README. Al ser vectorial y
// parametrico, cualquier tamano sale nitido y se puede recolorear en un sitio.
//
// La marca: dos formas redondeadas que se enlazan formando el hueco de una "N".
// Son el iPhone y el PC unidos -> el nexo. Sobre un cuadrado con esquinas al
// estilo de iOS (superelipse aproximada) y un degradado diagonal.

const MARCA = {
  // Paleta. Azul electrico -> cian, el mismo lenguaje del estudio actual.
  azul: '#3d9bff',
  cian: '#42e8e0',
  azulOscuro: '#1c6fd6',
  fondo0: '#12151b',
  fondo1: '#0b0d10',
  tinta: '#0a0e14',
};

// Dibuja la "N enlazada" centrada en un lienzo de 1024, con margen configurable.
// glifoSolo=true para las variantes monocromas (bandeja, plantillas).
function glifoNexo({ trazo = MARCA.azul, ancho = 132 } = {}) {
  // Dos trazos diagonales enganchados. Coordenadas pensadas sobre 1024.
  // Pata izquierda, diagonal y pata derecha forman la N; los remates redondos
  // y el solape central dan la sensacion de "eslabon".
  return `
    <g fill="none" stroke="${trazo}" stroke-width="${ancho}"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M 320 736 L 320 288" />
      <path d="M 320 300 L 704 724" />
      <path d="M 704 288 L 704 736" />
    </g>`;
}

// El eslabon: dos anillos redondeados que se enlazan, la marca principal.
// El de la derecha (cian, el iPhone) pasa por DELANTE del de la izquierda
// (azul, el PC). Para que la union sea nitida a cualquier tamano, el anillo de
// delante lleva un halo oscuro que lo separa limpiamente del de detras, en vez
// de un entrelazado real que se convierte en manchas por debajo de 64 px.
function glifoEslabon() {
  const w = 82;
  return `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <!-- anillo del PC (izquierda), en azul, detras -->
      <rect x="250" y="372" width="300" height="280" rx="140"
            fill="none" stroke="url(#trazoAzul)" stroke-width="${w}" />
      <!-- separacion: el mismo anillo de delante, mas grueso y del color del
           fondo, para abrir un hueco limpio donde cruza al de detras -->
      <rect x="474" y="372" width="300" height="280" rx="140"
            fill="none" stroke="${MARCA.fondo1}" stroke-width="${w + 30}" />
      <!-- anillo del iPhone (derecha), en cian, delante -->
      <rect x="474" y="372" width="300" height="280" rx="140"
            fill="none" stroke="url(#trazoCian)" stroke-width="${w}" />
    </g>`;
}

// Cuadrado base con esquinas iOS. r=228 sobre 1024 aproxima el "squircle".
function fondoRedondeado(id = 'fondoApp') {
  return `<rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#${id})" />`;
}

const DEGRADADOS = `
  <defs>
    <linearGradient id="fondoApp" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MARCA.fondo0}" />
      <stop offset="1" stop-color="${MARCA.fondo1}" />
    </linearGradient>
    <linearGradient id="trazoAzul" x1="250" y1="372" x2="550" y2="652" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MARCA.azul}" />
      <stop offset="1" stop-color="${MARCA.azulOscuro}" />
    </linearGradient>
    <linearGradient id="trazoCian" x1="474" y1="372" x2="774" y2="652" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MARCA.cian}" />
      <stop offset="1" stop-color="${MARCA.azul}" />
    </linearGradient>
    <filter id="brillo" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="7" result="b" />
      <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>`;

// --- Composiciones exportables --------------------------------------------

// Icono de app completo: fondo + eslabon con brillo. Para Windows e iOS.
function iconoApp() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  ${DEGRADADOS}
  ${fondoRedondeado()}
  <g filter="url(#brillo)">${glifoEslabon()}</g>
</svg>`;
}

// Version monocroma sobre transparente, para la bandeja del sistema y plantillas.
function iconoMono(color = '#ffffff') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  ${glifoNexo({ trazo: color, ancho: 150 })}
</svg>`;
}

// Logotipo horizontal: glifo + palabra "Nexo", para README y cabeceras. El
// glifo va en un SVG anidado a la izquierda (recorta su viewBox al area util
// del eslabon, ~230..790) para que no invada el texto.
function logotipo() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 320" width="1180" height="320">
  ${DEGRADADOS}
  <svg x="20" y="35" width="250" height="250" viewBox="230 350 564 324">
    <g filter="url(#brillo)">${glifoEslabon()}</g>
  </svg>
  <text x="315" y="205" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="210" font-weight="700" letter-spacing="-6" fill="#e6ebf2">Nexo</text>
  <text x="322" y="262" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="44" font-weight="500" letter-spacing="7" fill="#5b6675">CAMARA PRO</text>
</svg>`;
}

module.exports = { MARCA, iconoApp, iconoMono, logotipo, glifoEslabon, glifoNexo, DEGRADADOS, fondoRedondeado };
