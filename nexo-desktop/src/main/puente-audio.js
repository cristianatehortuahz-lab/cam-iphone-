'use strict';

// Puente del audio de FL Studio hacia OBS.
//
// FL manda su Master a OBS con ReaStream: un plugin al final del Master que
// envia por UDP a 127.0.0.1, y otro ReaStream dentro de OBS que recibe. Los dos
// se ligan al mismo puerto fijo (58710, compartido) y Windows entrega cada
// paquete dirigido a 127.0.0.1 a UNO solo de ellos: al primero que se ligo.
// Si FL arranca antes que OBS, o se reinicia OBS con FL abierto, los paquetes
// se los queda el propio FL y OBS recibe silencio, sin ningun aviso. Medido el
// 28/09/2026: grabacion de OBS en -91 dB en ese orden.
//
// El puente se liga a 127.0.0.1 exacto, que es mas especifico que el comodin
// de los dos ReaStream, asi que los paquetes de FL le llegan a el en cualquier
// orden. Y los reenvia por difusion a 127.255.255.255, que Windows entrega a
// TODOS los ligados al puerto: el ReaStream de OBS lo recibe siempre, y el de FL
// lo ignora porque esta en modo enviar. La difusion es de loopback, no sale por
// la red. Con el puente, la grabacion de OBS paso de -91 dB a -69 dB con el
// mismo orden de arranque.
//
// Va en un hilo propio: el proceso principal tambien reparte el video, y un
// atasco suyo de unas decenas de ms desbordaba el bufer por defecto de Windows
// (64 KB, ~100 ms de audio) y se oiria como un chasquido en el directo.
//
// Sin Nexo abierto no hay puente y vuelve la regla de antes: abrir OBS antes
// que FL.

const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { REASTREAM } = require('./puertos');

// Cuerpo del hilo. Se pasa como codigo (eval) y no como ruta de archivo para
// que funcione igual con la app empaquetada en asar.
function hilo() {
  const { parentPort, workerData } = require('worker_threads');
  const dgram = require('dgram');

  const LOCAL = '127.0.0.1';
  const DIFUSION = '127.255.255.255';
  const BUFER = 1 << 20; // ~1,7 s de audio estereo en float
  const SILENCIO = 5000; // ms sin paquetes para dar a FL por callado
  const { puerto } = workerData;

  const salida = dgram.createSocket('udp4');
  // reuseAddr: el puerto lo comparten los dos ReaStream y nosotros.
  const entrada = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let llegando = false;
  let ultimo = 0;

  const fallo = (e) => parentPort.postMessage({ tipo: 'error', mensaje: e.message });
  salida.on('error', fallo);
  entrada.on('error', fallo);

  // Audio en crudo para salida-audio.js (TikTok LIVE Studio no sabe recibir
  // ReaStream). Solo se desmontan los paquetes cuando alguien lo pide.
  //
  // Paquete ReaStream, comprobado con los de FL el 30/09/2026: 'MRSR', u32
  // tamano, identificador de 32 bytes, u8 canales, u32 frecuencia, u16 bytes de
  // audio, y a partir del byte 47 floats de 32 bits con los canales SEGUIDOS
  // (todo el izquierdo y luego todo el derecho), no intercalados.
  const CABECERA = 47;
  const LOTE = 441; // ~10 ms: agrupa varios paquetes por mensaje al proceso principal
  let identificadorSalida = null;
  let lote = [];
  let framesLote = 0;

  // --- Micro del iPhone ----------------------------------------------------
  //
  // Se suma al audio del DAW dentro de sus propios paquetes, justo antes de
  // reenviarlos: asi llega a OBS y a TikTok por el camino que ya existe, sin
  // tocar nada en ninguno de los dos, y el audio del DAW no gana ni un
  // milisegundo de retraso.
  //
  // El micro llega al ritmo del reloj del iPhone y los paquetes al de la
  // interfaz de audio, que nunca coinciden del todo. Entre los dos hay un
  // colchon de ~70 ms, y la velocidad de lectura se corrige hasta un 1 % para
  // mantenerlo (inaudible en una voz). Si se vacia, el micro calla hasta
  // rellenarse; si se desborda tras un atasco, salta al presente.
  const ID_MEZCLA = 'nexo-fl';
  const MIC_FS = 44100;
  const MIC_CAP = MIC_FS * 2;
  const MIC_OBJETIVO = Math.round(MIC_FS * 0.07);
  const micro = new Float32Array(MIC_CAP);
  let micLee = 0; // con decimales: se lee interpolando
  let micEscribe = 0;
  let micLleno = 0;
  let micActivo = false;
  let micGanancia = 1;
  let micEnMarcha = false;
  let micUltimo = 0; // cuando llego el ultimo trozo del iPhone
  let dawUltimo = 0; // cuando llego el ultimo paquete del DAW con ID_MEZCLA
  let relojFabrica = null; // ver fabricar(), mas abajo

  function meterMicro(pcm) {
    for (let i = 0; i < pcm.length; i++) {
      micro[micEscribe] = pcm[i];
      micEscribe = (micEscribe + 1) % MIC_CAP;
    }
    micLleno += pcm.length;
    micUltimo = Date.now();
    if (micLleno > MIC_OBJETIVO * 4) {
      micLee = (micEscribe - MIC_OBJETIVO + MIC_CAP) % MIC_CAP;
      micLleno = MIC_OBJETIVO;
    }
  }

  // Suma el micro a un paquete ReaStream, en su sitio.
  function mezclar(paquete) {
    if (!micActivo || Date.now() - micUltimo > 500) {
      micEnMarcha = false;
      micLleno = 0;
      micLee = micEscribe;
      return;
    }
    const canales = paquete.readUInt8(40);
    const fs = paquete.readUInt32LE(41);
    const bytes = paquete.readUInt16LE(45);
    const porCanal = bytes / 4 / canales;
    if (!canales || !fs || !Number.isInteger(porCanal) || CABECERA + bytes > paquete.length) return;

    const desvio = (micLleno - MIC_OBJETIVO) / MIC_OBJETIVO;
    const paso = (MIC_FS / fs) * (1 + Math.max(-0.01, Math.min(0.01, desvio * 0.02)));
    if (!micEnMarcha) {
      if (micLleno < MIC_OBJETIVO) return;
      micEnMarcha = true;
    }
    if (micLleno < porCanal * paso + 2) {
      micEnMarcha = false;
      return;
    }
    for (let i = 0; i < porCanal; i++) {
      const a = Math.floor(micLee);
      const parte = micLee - a;
      const s = (micro[a] * (1 - parte) + micro[(a + 1) % MIC_CAP] * parte) * micGanancia;
      micLee += paso;
      if (micLee >= MIC_CAP) micLee -= MIC_CAP;
      for (let c = 0; c < canales; c++) {
        const donde = CABECERA + (c * porCanal + i) * 4;
        paquete.writeFloatLE(paquete.readFloatLE(donde) + s, donde);
      }
    }
    micLleno -= porCanal * paso;
  }

  const esDeMezcla = (paquete) =>
    paquete.length >= CABECERA &&
    paquete.toString('latin1', 0, 4) === 'MRSR' &&
    paquete.toString('latin1', 8, 40).replace(/\0+$/, '') === ID_MEZCLA;

  parentPort.on('message', (m) => {
    if (m && m.tipo === 'salida') {
      identificadorSalida = m.activa ? m.identificador : null;
      lote = [];
      framesLote = 0;
    } else if (m && m.tipo === 'micro') {
      micActivo = Boolean(m.activo);
      if (typeof m.ganancia === 'number') micGanancia = m.ganancia;
      clearInterval(relojFabrica);
      relojFabrica = micActivo ? setInterval(fabricar, 3) : null;
    } else if (m && m.tipo === 'micro-pcm') {
      if (micActivo) meterMicro(m.pcm);
    }
  });

  function desmontar(paquete) {
    if (paquete.length < CABECERA || paquete.toString('latin1', 0, 4) !== 'MRSR') return;
    if (paquete.toString('latin1', 8, 40).replace(/\0+$/, '') !== identificadorSalida) return;
    const canales = paquete.readUInt8(40);
    const fs = paquete.readUInt32LE(41);
    const bytes = paquete.readUInt16LE(45);
    const porCanal = bytes / 4 / canales;
    if (!canales || !Number.isInteger(porCanal) || CABECERA + bytes > paquete.length) return;

    // Copia a un bufer propio: el audio empieza en el byte 47, que no esta
    // alineado a 4 y no se puede leer como Float32Array en su sitio.
    const copia = new Uint8Array(bytes);
    copia.set(paquete.subarray(CABECERA, CABECERA + bytes));
    const f = new Float32Array(copia.buffer);
    const izq = f.subarray(0, porCanal);
    const der = canales > 1 ? f.subarray(porCanal, 2 * porCanal) : izq;
    lote.push({ fs, izq, der });
    framesLote += porCanal;
    if (framesLote < LOTE) return;

    const l = new Float32Array(framesLote);
    const r = new Float32Array(framesLote);
    let i = 0;
    for (const t of lote) {
      l.set(t.izq, i);
      r.set(t.der, i);
      i += t.izq.length;
    }
    parentPort.postMessage({ tipo: 'pcm', fs: lote[lote.length - 1].fs, l, r }, [l.buffer, r.buffer]);
    lote = [];
    framesLote = 0;
  }

  salida.bind(0, LOCAL, () => {
    salida.setBroadcast(true);
    salida.setSendBufferSize(BUFER);
    const puertoSalida = salida.address().port;

    entrada.on('message', (paquete, origen) => {
      // Nuestra propia difusion vuelve tambien a este socket: no reenviarla o
      // seria un bucle.
      if (origen.port === puertoSalida && origen.address === LOCAL) return;
      if (esDeMezcla(paquete)) {
        dawUltimo = Date.now();
        mezclar(paquete);
      }
      salida.send(paquete, puerto, DIFUSION);
      if (identificadorSalida) desmontar(paquete);
      ultimo = Date.now();
      if (!llegando) {
        llegando = true;
        parentPort.postMessage({ tipo: 'estado', llega: true });
      }
    });

    entrada.bind(puerto, LOCAL, () => {
      entrada.setRecvBufferSize(BUFER);
      parentPort.postMessage({ tipo: 'listo' });
    });

  });

  // Sin DAW abierto no hay paquetes en los que mezclar: entonces el puente los
  // fabrica el mismo, con el micro solo, para que se oiga igual. Mismo formato
  // que los de FL: 2 canales, 44 100 Hz, 144 muestras por paquete. En cuanto el
  // DAW vuelve a mandar, se deja de fabricar. El reloj solo corre con el micro
  // encendido.
  const BLOQUE = 144;
  const cabeceraFabrica = Buffer.alloc(CABECERA);
  cabeceraFabrica.write('MRSR', 0, 'latin1');
  cabeceraFabrica.writeUInt32LE(CABECERA + BLOQUE * 2 * 4, 4);
  cabeceraFabrica.write(ID_MEZCLA, 8, 'latin1');
  cabeceraFabrica.writeUInt8(2, 40);
  cabeceraFabrica.writeUInt32LE(MIC_FS, 41);
  cabeceraFabrica.writeUInt16LE(BLOQUE * 2 * 4, 45);
  let fabricando = false;
  let inicioFabrica = 0n;
  let fabricadas = 0;

  function fabricar() {
    const ahora = Date.now();
    if (!micActivo || ahora - dawUltimo < 300 || ahora - micUltimo > 500) {
      fabricando = false;
      return;
    }
    if (!fabricando) {
      fabricando = true;
      inicioFabrica = process.hrtime.bigint();
      fabricadas = 0;
    }
    const debidas = Number(((process.hrtime.bigint() - inicioFabrica) * BigInt(MIC_FS)) / 1000000000n);
    // Tras un atasco no se recupera lo perdido: se oiria todo de golpe.
    if (debidas - fabricadas > MIC_FS / 5) fabricadas = debidas - BLOQUE;
    while (debidas - fabricadas >= BLOQUE) {
      const paquete = Buffer.alloc(CABECERA + BLOQUE * 2 * 4);
      cabeceraFabrica.copy(paquete);
      mezclar(paquete);
      salida.send(paquete, puerto, DIFUSION);
      if (identificadorSalida) desmontar(paquete);
      fabricadas += BLOQUE;
    }
  }

  setInterval(() => {
    if (llegando && Date.now() - ultimo > SILENCIO) {
      llegando = false;
      parentPort.postMessage({ tipo: 'estado', llega: false });
    }
  }, 1000);
}

class PuenteAudio extends EventEmitter {
  constructor({ puerto = REASTREAM } = {}) {
    super();
    this.puerto = puerto;
    this.hilo = null;
  }

  iniciar() {
    return new Promise((ok, mal) => {
      let listo = false;
      this.hilo = new Worker(`(${hilo.toString()})()`, {
        eval: true,
        workerData: { puerto: this.puerto },
      });
      this.hilo.on('message', (m) => {
        if (m.tipo === 'listo') {
          listo = true;
          ok();
        } else if (m.tipo === 'estado') {
          this.emit('estado', m.llega);
        } else if (m.tipo === 'pcm') {
          this.emit('pcm', m);
        } else if (m.tipo === 'error') {
          if (listo) this.emit('error', new Error(m.mensaje));
          else mal(new Error(m.mensaje));
        }
      });
      this.hilo.on('error', (e) => (listo ? this.emit('error', e) : mal(e)));
    });
  }

  // Pide (o deja de pedir) el audio en crudo de un identificador de ReaStream.
  // Llega como eventos 'pcm': { fs, l, r } con Float32Array por canal.
  activarSalida(activa, identificador = 'nexo-fl') {
    if (this.hilo) this.hilo.postMessage({ tipo: 'salida', activa, identificador });
  }

  // Enciende o apaga la mezcla del micro del iPhone en el audio que se reenvia,
  // con su volumen (1 = tal cual llega).
  micro(activo, ganancia = 1) {
    if (this.hilo) this.hilo.postMessage({ tipo: 'micro', activo, ganancia });
  }

  // Audio del micro del iPhone ya decodificado: Float32Array mono a 44 100 Hz
  // (micro-iphone.js). Se entrega al hilo sin copiarlo.
  microPcm(pcm) {
    if (this.hilo) this.hilo.postMessage({ tipo: 'micro-pcm', pcm }, [pcm.buffer]);
  }

  detener() {
    if (this.hilo) this.hilo.terminate();
    this.hilo = null;
  }
}

module.exports = { PuenteAudio };
