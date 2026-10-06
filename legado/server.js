'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode');

const certificados = require('./certificados');
const acceso = require('./acceso');

const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

const CLAVE = acceso.cargarClave(CERT_DIR);
const guardia = acceso.crearGuardia(CLAVE);
const PUERTOS = [HTTPS_PORT, HTTP_PORT];

let CA_PEM = '';

// ---------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------

function listarIPs() {
  const salida = [];
  for (const [nombre, direcciones] of Object.entries(os.networkInterfaces())) {
    for (const dir of direcciones || []) {
      if (dir.family !== 'IPv4' || dir.internal) continue;
      salida.push({ nombre, ip: dir.address, usb: dir.address.startsWith('172.20.10.') });
    }
  }
  salida.sort((a, b) => Number(b.usb) - Number(a.usb));
  return salida;
}

function urlMovil(ip) {
  return `https://${ip}:${HTTPS_PORT}/movil?c=${CLAVE}`;
}

// ---------------------------------------------------------------------------
// Archivos estaticos
// ---------------------------------------------------------------------------

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const PAGINA_DENEGADA = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso restringido</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0d10;color:#e6ebf2;font-family:-apple-system,'Segoe UI',sans-serif;text-align:center;padding:32px}
div{max-width:380px}h1{font-size:19px;margin:0 0 12px}p{color:#8b97a8;font-size:14px;line-height:1.6;margin:0}</style>
</head><body><div><h1>Acceso restringido</h1>
<p>Esta camara solo es accesible con el enlace correcto. Abre la direccion que aparece
en el estudio del PC, o escanea el codigo QR.</p></div></body></html>`;

// La pone iniciar() con lo que le pase Nexo Desktop; la lee /api/nexo.
let fuenteEstadoNexo = null;

function servirEstatico(req, res) {
  // Todo el cuerpo va en try/catch: una excepcion sincrona aqui, sin recoger,
  // se convierte en uncaughtException y mata el proceso. Para algo que emite en
  // directo, cortar la emision por una peticion mal formada es inaceptable.
  try {
    let url;
    let ruta;
    try {
      url = new URL(req.url, 'https://local');
      // decodeURIComponent lanza URIError con un porcentaje mal formado (p.ej.
      // "/%"). Ocurre antes que el control de acceso, asi que sin este guardia
      // cualquiera en la red tumba el servidor con una sola peticion sin clave.
      ruta = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Peticion invalida');
      return;
    }

    // Caracteres de control (incluido el byte nulo): fs.readFile los rechaza
    // lanzando de forma sincrona, asi que se cortan aqui.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(ruta)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Peticion invalida');
      return;
    }

    // El certificado raiz es lo unico publico: hay que poder descargarlo antes
    // de tener acceso, y no revela nada -- es solo una clave publica.
    if (ruta === '/certificado.crt' || ruta === '/cert') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Cache-Control': 'no-store' });
      return res.end(CA_PEM);
    }

    const veredicto = guardia.revisar(req, url);
    if (!veredicto.permitido) {
      res.writeHead(401, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-store' });
      return res.end(PAGINA_DENEGADA);
    }

    const cabeceras = { 'Cache-Control': 'no-store' };
    if (veredicto.fijarCookie) {
      // HttpOnly y SameSite=Lax: la clave no queda expuesta a scripts ni viaja
      // desde otros sitios. Secure solo si la peticion vino por TLS (el estudio
      // local va por HTTP, y con Secure el navegador descartaria la cookie).
      const secure = req.socket.encrypted ? '; Secure' : '';
      cabeceras['Set-Cookie'] =
        `${acceso.NOMBRE_COOKIE}=${CLAVE}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
    }

    if (ruta === '/') ruta = '/index.html';
    if (ruta === '/movil' || ruta === '/iphone') ruta = '/phone.html';
    if (ruta === '/obs') ruta = '/obs.html';

    if (ruta === '/api/info') {
      const interfaces = listarIPs();
      const cable = interfaces.find((i) => i.usb) || null;
      const principal = cable || interfaces[0];
      res.writeHead(200, { ...cabeceras, 'Content-Type': TIPOS['.json'] });
      return res.end(
        JSON.stringify({
          cable: Boolean(cable),
          interfaces,
          puerto: HTTPS_PORT,
          urlMovil: principal ? urlMovil(principal.ip) : null,
        })
      );
    }

    // Solo desde el propio PC: es para el script de inicio del directo, y no
    // tiene por que saber nada de esto el movil que entra con la clave.
    if (ruta === '/api/nexo') {
      if (!acceso.esLocal(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Prohibido');
      }
      let estado = null;
      try {
        estado = fuenteEstadoNexo ? fuenteEstadoNexo() : null;
      } catch (e) {
        estado = { error: e.message };
      }
      res.writeHead(200, { ...cabeceras, 'Content-Type': TIPOS['.json'] });
      return res.end(JSON.stringify(estado));
    }

    const destino = path.join(PUBLIC_DIR, path.normalize(ruta));
    // El separador final evita que una carpeta hermana llamada "publicXX" cuele.
    if (destino !== PUBLIC_DIR && !destino.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Prohibido');
      return;
    }

    fs.readFile(destino, (err, datos) => {
      if (err) {
        res.writeHead(404, { ...cabeceras, 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('No encontrado');
      }
      res.writeHead(200, {
        ...cabeceras,
        'Content-Type': TIPOS[path.extname(destino)] || 'application/octet-stream',
      });
      res.end(datos);
    });
  } catch (err) {
    // Defensa en profundidad: cualquier ruta de excepcion no prevista responde
    // 500 en vez de derribar el proceso.
    console.error('  Error sirviendo peticion:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Error interno');
    }
  }
}

// ---------------------------------------------------------------------------
// Senalizacion WebRTC
// ---------------------------------------------------------------------------

const clientes = new Map(); // id -> { ws, rol }
let siguienteId = 1;
let ultimosAjustesImagen = null;

function enviar(ws, mensaje) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(mensaje));
}

function difundir(rol, mensaje) {
  for (const cliente of clientes.values()) {
    if (cliente.rol === rol) enviar(cliente.ws, mensaje);
  }
}

function idsPorRol(rol) {
  return [...clientes.entries()].filter(([, c]) => c.rol === rol).map(([id]) => id);
}

// Reparte una trama de video del transporte nativo entre los visores que la
// hayan pedido. Hace falta porque por cable el iPhone NO participa en la
// senalizacion WebRTC: la fuente de OBS se quedaba en negro aunque el estudio
// estuviera recibiendo imagen.
//
// Es opt-in: el estudio dentro de Electron ya recibe el video por IPC y pedirlo
// aqui seria mandarle 12 Mbps para nada.
// Avisa a los visores de algo que pasa en el transporte nativo (por ahora, que
// la sesion se cerro). Va por separado de la senalizacion WebRTC porque el
// iPhone por cable no existe para ella.
function avisarVisores(mensaje) {
  difundir('visor', mensaje);
}

// Margen de cola por visor antes de empezar a saltarse fotogramas. Antes era de
// 4 MiB, pero a 4K y 32 Mbps un fotograma ronda los 130 KB: eran unos treinta,
// o sea un segundo entero de video acumulado antes de soltar nada. La latencia
// crecia hasta ese segundo y entonces se descartaba una rafaga de golpe.
const MARGEN_VISOR = 512 * 1024;

// Tope absoluto: pasado esto no pasa ni un fotograma clave. Sin el, un visor
// atascado acumularia justo los fotogramas mas grandes.
const TOPE_VISOR = 4 * 1024 * 1024;

function difundirVideo(carga) {
  // Byte 8, bit 0 = fotograma clave. Es el mismo formato que lee obs.html, lo
  // escribe protocolo.codificarCargaMedia en el proceso principal.
  const clave = carga.length > 8 && (carga[8] & 1) !== 0;

  for (const cliente of clientes.values()) {
    if (!cliente.quiereVideo) continue;
    if (cliente.ws.readyState !== cliente.ws.OPEN) continue;

    const cola = cliente.ws.bufferedAmount;
    if (cola > TOPE_VISOR) continue;
    // Los delta se sacrifican primero. Tirar una clave estropea los dos
    // segundos de GOP que vienen detras, asi que se le da via preferente.
    if (!clave && cola > MARGEN_VISOR) continue;

    cliente.ws.send(carga, { binary: true });
  }
}

function iniciarSenalizacion(servidor) {
  const wss = new WebSocketServer({
    server: servidor,
    path: '/ws',
    // Los ajustes de imagen y la senalizacion son mensajes pequenos. 256 KB
    // sobra y evita que alguien reserve los 100 MB por defecto por mensaje.
    maxPayload: 262144,
    verifyClient: ({ req }) => guardia.revisarSocket(req, PUERTOS),
  });

  wss.on('error', (err) => console.error('  Error en el WebSocket:', err.message));

  wss.on('connection', (ws) => {
    const id = String(siguienteId++);
    let rol = null;

    ws.on('message', (bruto) => {
      let msg;
      try {
        msg = JSON.parse(bruto);
      } catch {
        return;
      }

      switch (msg.tipo) {
        case 'hola': {
          if (rol) return; // ya se presento: no se cambia de papel a mitad
          rol = msg.rol === 'movil' ? 'movil' : 'visor';
          clientes.set(id, { ws, rol });
          enviar(ws, { tipo: 'bienvenida', id, rol });

          if (rol === 'movil') {
            difundir('visor', { tipo: 'movil-conectado' });
            for (const visorId of idsPorRol('visor')) {
              enviar(ws, { tipo: 'visor-listo', de: visorId });
            }
            console.log(`  [+] iPhone conectado (id ${id})`);
          } else {
            enviar(ws, {
              tipo: idsPorRol('movil').length ? 'movil-conectado' : 'movil-desconectado',
            });
            if (ultimosAjustesImagen) enviar(ws, { tipo: 'imagen', valores: ultimosAjustesImagen });
            difundir('movil', { tipo: 'visor-listo', de: id });
            console.log(`  [+] Visor conectado (id ${id})`);
          }
          break;
        }

        case 'oferta':
        case 'respuesta':
        case 'ice': {
          if (!rol) return;
          const destino = clientes.get(String(msg.para));
          if (destino) enviar(destino.ws, { ...msg, de: id });
          break;
        }

        // Un visor pide (o deja de pedir) el video del transporte nativo.
        case 'video-nativo': {
          const cliente = clientes.get(id);
          if (cliente) cliente.quiereVideo = msg.activo !== false;
          break;
        }

        // Telemetria de los visores (fuente de OBS y estudio): cuanto llega y
        // cuanto se pinta. Lo que pasa dentro de la fuente de OBS no se puede
        // inspeccionar desde fuera, y sin esto un salto de video era adivinar.
        // Solo campos numericos saneados: cualquier visor puede mandar esto.
        case 'estadistica': {
          const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : '?');
          const origen = String(msg.origen || '?').replace(/[^a-z]/gi, '').slice(0, 12);
          const donde =
            msg.antesClaveMs !== undefined
              ? ` [antes de clave ${n(msg.antesClaveMs)}, tras clave ${n(msg.trasClaveMs)}, otros ${n(msg.otrosMs)}]`
              : '';
          // Hueco a la entrada del decodificador y su cola: separan un atasco
          // aguas arriba de uno del propio decodificador (02/10/2026).
          const entrada =
            msg.huecoLlegadaMaxMs !== undefined
              ? ` (llegada max ${n(msg.huecoLlegadaMaxMs)} ms, cola max ${n(msg.colaMax)}, ${msg.porHardware ? 'GPU' : 'CPU'})`
              : '';
          console.log(
            `[video] ${origen}: llegan ${n(msg.llegadas)} pintados ${n(msg.pintados)} ` +
              `hueco max ${n(msg.huecoMaxMs)} ms${entrada}${donde}${msg.visible === false ? ' (oculta)' : ''}`
          );
          break;
        }

        // Ordenes del PC hacia el iPhone.
        case 'control': {
          if (rol !== 'visor') return;
          difundir('movil', { ...msg, de: id });
          break;
        }

        // Estado que publica el iPhone.
        case 'estado': {
          if (rol !== 'movil') return;
          difundir('visor', { ...msg, de: id });
          break;
        }

        // Correccion de imagen, de visor a visor, para que la salida de OBS
        // siga en vivo lo que se ajusta en el estudio.
        case 'imagen': {
          if (rol !== 'visor') return;
          ultimosAjustesImagen = msg.valores || null;
          for (const [otroId, cliente] of clientes) {
            if (cliente.rol === 'visor' && otroId !== id) enviar(cliente.ws, { ...msg, de: id });
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      const cliente = clientes.get(id);
      clientes.delete(id);
      if (!cliente) return;

      if (cliente.rol === 'movil') {
        if (idsPorRol('movil').length === 0) difundir('visor', { tipo: 'movil-desconectado' });
        console.log(`  [-] iPhone desconectado (id ${id})`);
      } else {
        difundir('movil', { tipo: 'visor-fuera', de: id });
        console.log(`  [-] Visor desconectado (id ${id})`);
      }
    });

    ws.on('error', () => {});
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

// Arranca los servidores y devuelve referencias e informacion. NO llama a
// process.exit: cuando corre embebido dentro de Electron, matar el proceso
// tumbaria toda la app. Los errores se lanzan para que quien llama decida.
// estadoNexo: funcion que da el estado de Nexo Desktop (iPhone por cable, audio
// de FL). La sirve /api/nexo, que usa herramientas/iniciar-directo.ps1 para
// comprobar que todo esta listo antes de un directo.
async function iniciar({ silencioso = false, estadoNexo = null } = {}) {
  fuenteEstadoNexo = estadoNexo;
  const log = silencioso ? () => {} : (...a) => console.log(...a);

  const interfaces = listarIPs();
  const ips = interfaces.map((i) => i.ip);

  if (ips.length === 0) {
    throw new Error('No se encontro ninguna interfaz de red. Conecta el cable o el WiFi.');
  }

  const material = certificados.preparar(CERT_DIR, ips);
  CA_PEM = material.ca;

  const servidorHttps = https.createServer({ cert: material.cert, key: material.key }, servirEstatico);
  iniciarSenalizacion(servidorHttps);

  // En el PC el estudio se abre por HTTP en localhost: sin avisos y sin clave.
  // Desde fuera hay que ir por HTTPS, porque Safari no da acceso a la camara
  // sin conexion segura.
  const servidorHttp = http.createServer((req, res) => {
    if (acceso.esLocal(req) || req.url.startsWith('/certificado.crt') || req.url.startsWith('/cert')) {
      return servirEstatico(req, res);
    }
    // El destino se toma de la IP local del socket, no de la cabecera Host: esa
    // la controla quien pide, y usarla permitiria una redireccion abierta.
    const host = req.socket.localAddress?.replace(/^::ffff:/, '') || 'localhost';
    const ruta = req.url.startsWith('/') ? req.url : '/';
    res.writeHead(302, { Location: `https://${host}:${HTTPS_PORT}${ruta}` }).end();
  });
  iniciarSenalizacion(servidorHttp);

  // Sin estos manejadores, un puerto ocupado (arrancar dos veces) revienta con
  // una traza de Node en vez de un aviso claro.
  const arrancar = (servidor, puerto) =>
    new Promise((resolver, rechazar) => {
      servidor.once('error', rechazar);
      servidor.listen(puerto, '0.0.0.0', () => {
        servidor.off('error', rechazar);
        servidor.on('error', (err) => console.error(`  Error en el servidor (${puerto}):`, err.message));
        resolver();
      });
    });

  try {
    await arrancar(servidorHttps, HTTPS_PORT);
    await arrancar(servidorHttp, HTTP_PORT);
  } catch (err) {
    // Cerrar lo que hubiera abierto antes de propagar.
    servidorHttps.close();
    servidorHttp.close();
    if (err.code === 'EADDRINUSE') {
      err.mensajeUsuario = `El puerto ${err.port} ya esta ocupado. Puede que ya haya una instancia corriendo.`;
    }
    throw err;
  }

  const usb = interfaces.find((i) => i.usb);
  const principal = usb || interfaces[0];
  const destino = urlMovil(principal.ip);

  log('');
  log('  ================================================');
  log('    CAMARA IPHONE  ->  ESTUDIO EN EL PC');
  log('  ================================================');
  log('');

  if (material.caNueva) {
    log('  Autoridad raiz creada. Instalala en el iPhone una sola vez:');
    log(`       http://${principal.ip}:${HTTP_PORT}/certificado.crt`);
    log('  Despues: Ajustes > General > Informacion >');
    log('           Ajustes de confianza del certificado > activar "Camara iPhone CA"');
  } else if (material.reemitido) {
    log('  Certificado de servidor reemitido para las IPs actuales.');
    log('  No hace falta tocar el iPhone: la raiz instalada sigue valiendo.');
  } else {
    log('  Certificados en orden.');
  }

  log('');
  log('  1. En el PC abre el estudio (sin clave ni avisos):');
  log(`       http://localhost:${HTTP_PORT}`);
  log('');
  log('  2. En el iPhone, en Safari:');
  log(`       ${destino}`);
  log('');

  if (!usb) {
    log('  Aviso: no se detecta el cable. La direccion de arriba es por WiFi.');
    log('');
  }

  log(`  Clave de acceso: ${CLAVE}`);
  log('');
  for (const i of interfaces) {
    log(`       ${urlMovil(i.ip)}   (${i.nombre}${i.usb ? ' <- CABLE' : ''})`);
  }
  log('');

  if (!silencioso) {
    try {
      log(await qrcode.toString(destino, { type: 'terminal', small: true }));
    } catch {
      /* el QR es un extra */
    }
    log('  Ctrl+C para detener.');
    log('');
  }

  // Cierra ambos servidores de forma ordenada. Lo usa Electron al salir.
  const detener = () =>
    Promise.all([
      new Promise((r) => servidorHttps.close(r)),
      new Promise((r) => servidorHttp.close(r)),
    ]);

  return {
    detener,
    difundirVideo,
    avisarVisores,
    interfaces,
    clave: CLAVE,
    destino,
    urlMovil,
    puertos: { https: HTTPS_PORT, http: HTTP_PORT },
    hayCable: Boolean(usb),
  };
}

module.exports = { iniciar };

// Uso por linea de comandos (node server.js). Solo entonces se instalan los
// manejadores globales y se sale con codigo de error si falla el arranque.
if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error('  Excepcion no capturada (el servidor sigue):', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('  Promesa rechazada sin capturar:', err?.message || err);
  });

  iniciar().catch((err) => {
    console.error('Error al arrancar:', err.mensajeUsuario || err.message);
    process.exit(1);
  });
}
