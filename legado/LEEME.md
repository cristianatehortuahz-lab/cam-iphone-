# Camara iPhone 17 -> Estudio en el PC

Convierte tu iPhone 17 en la camara de este PC, **por el cable USB-C**, para
directos, TikToks, Reels, Shorts y YouTube. Gratis, sin marcas de agua y sin
limite de resolucion.

El iPhone 17 tiene **principal 48 MP (1x)**, **ultra gran angular 48 MP (0,5x)**
y **frontal 18 MP**. Las tres se pueden usar y cambiar en caliente desde el PC.

---

## Arranque rapido

Doble clic en **`iniciar.bat`**. Se abre el estudio en `http://localhost:8080`.

---

## Primera vez (unos 10 minutos)

### 1. Crear la red por cable

1. Conecta el iPhone al PC con el cable USB-C.
2. Si sale el aviso en el iPhone, pulsa **Confiar en este equipo** y mete tu codigo.
3. En el iPhone: **Ajustes › Compartir Internet › Permitir a otros: ACTIVADO**.
4. Windows creara el adaptador *Apple Mobile Device Ethernet*. Si pregunta por el
   tipo de red, elige **Red privada**.

Ahora el PC y el iPhone comparten la red `172.20.10.x`, **que viaja por el cable**.
No gastas datos moviles: el trafico entre los dos equipos es local.

> Sin el paso 3 no hay red por cable. Windows detecta el iPhone igualmente (para
> fotos y sincronizacion), pero eso no sirve para transmitir video.

### 2. Arrancar el servidor

Doble clic en `iniciar.bat`. La consola muestra la direccion exacta del iPhone,
con la clave de acceso incluida, del tipo:

```
https://172.20.10.2:8443/movil?c=mhjwxgwuw92e
```

Esa direccion aparece tambien arriba a la derecha del estudio, y como codigo QR
en la consola.

### 3. Instalar la autoridad raiz en el iPhone (una sola vez, para siempre)

Safari no da acceso a la camara sin conexion segura. El programa crea una
**autoridad raiz propia** que se genera una unica vez y no cambia nunca.
Instalandola, el iPhone confia en este servidor aunque despues cambies de red,
conectes el cable o reinstales.

1. En Safari del iPhone: `http://172.20.10.2:8080/certificado.crt`
   (HTTP y puerto 8080: ahi no hay aviso, y no hace falta clave)
2. **Permitir** para descargar el perfil.
3. **Ajustes › Perfil descargado › Instalar**, mete el codigo, **Instalar** otra vez.
4. Este paso se olvida siempre:
   **Ajustes › General › Informacion › Ajustes de confianza del certificado**
   y activa **Camara iPhone CA**.

> Solo se hace una vez. Al conectar el cable aparecera una IP nueva y el programa
> reemitira su certificado de servidor, pero como esta firmado por la raiz que ya
> tienes instalada, **el iPhone no vuelve a preguntar nada**.

### 4. Transmitir

1. En Safari del iPhone abre la direccion con `?c=...` del paso 2.
2. **Empezar** y autoriza la camara.
3. La imagen aparece en el estudio del PC.

La clave queda guardada en una cookie, asi que a partir de ahi puedes entrar sin
volver a escribirla. Guarda la pagina en la pantalla de inicio y listo.

**Truco:** en el iPhone, *Compartir › Anadir a pantalla de inicio*. Queda como una
app y arranca a pantalla completa.

---

## Usarla en TikTok Live, YouTube, Zoom, Discord…

Estas apps solo aceptan camaras del sistema. El puente es la **camara virtual de
OBS**, que ya tienes instalado (OBS Studio 30.2.2).

### Configurar OBS (una vez)

1. Abre **OBS Studio**.
2. En *Fuentes* pulsa **+** › **Navegador**. Ponle el nombre que quieras.
3. Rellena:
   - **URL**: pulsa **Copiar direccion OBS** en el panel del estudio y pegala.
     Normalmente `http://localhost:8080/obs`
   - **Anchura / Altura**: segun a donde emitas —
     · Vertical (TikTok, Reels, Shorts): **1080 x 1920**
     · Horizontal (YouTube, Twitch): **1920 x 1080**
   - **FPS personalizados**: 30 o 60, igual que hayas puesto en el estudio.
   - Marca **Controlar audio mediante OBS** si activas el microfono del iPhone.
   - Deja **desmarcado** "Apagar la fuente cuando no este visible".
4. Ajusta el lienzo en *Ajustes › Video › Resolucion base* al mismo formato.
5. Pulsa **Iniciar camara virtual** (abajo a la derecha).

### En la app de destino

Elige **OBS Virtual Camera** como camara:

| App | Donde |
|---|---|
| TikTok Live Studio | Anadir fuente › Camara › OBS Virtual Camera |
| YouTube (en el navegador) | Icono de camara en la barra de direcciones |
| Zoom | Ajustes › Video › Camara |
| Discord | Ajustes › Voz y video › Camara |
| Streamlabs | Anadir fuente › Dispositivo de captura de video |

### Parametros de la salida OBS

Se pueden anadir a la URL:

| Parametro | Efecto |
|---|---|
| `?formato=9:16` | **Recorta** la salida a esa proporcion, centrada. Tambien 4:5, 1:1, 16:9 |
| `?rotar=90` | Gira la imagen 90, 180 o 270 grados |
| `?espejo=1` | Refleja en horizontal |
| `?ajuste=contener` | Encaja entera en vez de recortar (deja bandas) |
| `?audio=1` | Deja pasar el audio del iPhone |

Con `formato` el lienzo sale ya con las dimensiones finales (por ejemplo,
1920x1080 recortado a 9:16 entrega 608x1080), asi que OBS recibe el encuadre
hecho y no tienes que recortarlo con una transformacion.

Se combinan con `&`: `http://localhost:8080/obs?rotar=90&audio=1`

---

## El estudio

### Panel derecho — controlan el iPhone en remoto

| Control | Que hace |
|---|---|
| **Lente** | Principal 1x, ultra gran angular 0,5x o frontal. Cambia **sin cortar el directo** |
| **Resolucion** | 720p / 1080p / 1440p / 4K |
| **Fotogramas** | 24 (cine), 30, 60 (fluido) |
| **Prioridad** | *Fluidez* para movimiento, *Nitidez* para plano fijo y detalle |
| **Zoom** | Recorte optico y digital. En la principal, 2x mantiene calidad optica |
| **Exposicion** | Sube o baja la luz sin tocar el iPhone |
| **Enfoque y color** | Modo de enfoque y balance de blancos, si la lente lo permite |

Los controles de zoom, exposicion y enfoque **solo aparecen si tu lente los
soporta**: el iPhone informa de sus capacidades reales y el panel se dibuja a
partir de ellas.

### Encuadre

- **Formato**: dibuja la guia de 9:16, 4:5, 1:1 o 16:9 sobre la imagen.
- **Zona UI**: marca en rojo donde TikTok e Instagram tapan con sus botones y
  textos. Si pones algo importante ahi, no se vera.
- **Rejilla**: regla de los tercios.

### Pie

| Control | Atajo |
|---|---|
| Linterna | |
| Reflejar | `m` |
| Girar | |
| Datos (resolucion, fps, bitrate, codec, ping, perdidas) | `d` |
| Captura PNG — **recorta al formato elegido** | `s` |
| Grabar video | `r` |
| Rejilla | `g` |
| Pantalla completa | `f` |

Capturas y grabaciones van a tu carpeta de **Descargas**.

---

## Calidad: que elegir

| Uso | Resolucion | Fps | Prioridad |
|---|---|---|---|
| Directo hablando a camara | 1080p | 30 | Nitidez |
| TikTok / Reels con movimiento | 1080p | 60 | Fluidez |
| YouTube calidad alta | 1440p o 4K | 30 | Nitidez |
| Videojuegos o deporte | 1080p | 60 | Fluidez |

El programa pide **H.264** al iPhone, que lo codifica **por hardware**. Eso da
mejor imagen, menos calor y mucha menos bateria que el VP8 por software que
elegiria WebRTC por su cuenta. Compruebalo en **Datos**: debe poner `H264`.

4K a 60 fps calienta el iPhone en sesiones largas. Para directos de mas de media
hora, 1080p60 es la apuesta segura. Conviene tenerlo cargando.

---

## Si algo no va

**No aparece la red por cable / el iPhone no carga la pagina**
- Casi siempre es *Compartir Internet* apagado. Revisa el paso 1.3.
- Reinicia el servidor despues de activarlo: la direccion cambia.
- Comprueba en la consola que sale una IP `172.20.10.x`.
- Cortafuegos. Una vez, en PowerShell **como administrador**:

  ```
  New-NetFirewallRule -DisplayName "Camara iPhone" -Direction Inbound -Protocol TCP -LocalPort 8443,8080 -Action Allow -Profile Any
  ```

**No aparece "Compartir Internet" en el iPhone**
- Depende del operador; algunos planes no lo incluyen. Sin eso no hay red por cable.
- El programa funciona igual por WiFi con el PC y el iPhone en la misma red. La
  direccion WiFi tambien sale en la consola. Buena calidad, algo mas de latencia.

**Safari dice "conexion no privada"**
- Falta el paso 3.4, activar la confianza total del certificado.
- Salida rapida: *Mostrar detalles › Visitar este sitio web*.

**Safari no pide permiso de camara**
- *Ajustes › Safari › Camara › Preguntar*.
- Tienes que estar en `https://…:8443`, no en `:8080`.

**En OBS se ve negro**
- La fuente de navegador debe apuntar a `http://localhost:8080/obs` (HTTP y
  localhost, no HTTPS).
- Desmarca *Apagar la fuente cuando no este visible*.
- Pulsa el boton **Actualizar cache de la pagina actual** en las propiedades.

**Se ve entrecortado**
- Baja a 1080p30 y pon prioridad *Fluidez*.
- Abre **Datos**: si el ping pasa de 5 ms o hay perdidas, no vas por el cable sino
  por WiFi. Apaga el WiFi del iPhone para forzar el cable.

**Se corta al bloquearse el iPhone**
- La pagina pide bloqueo de pantalla sola. Si tu iOS no lo permite:
  *Ajustes › Pantalla y brillo › Bloqueo automatico › Nunca*.

**Al arrancar dice "El puerto 8443 ya esta ocupado"**
- Ya hay una instancia corriendo (mira si tienes otra ventana negra abierta).
  Cierrala y vuelve a lanzar `iniciar.bat`.
- Si necesitas otra a proposito, usa otros puertos:
  `set HTTPS_PORT=9443 & set HTTP_PORT=9080 & node server.js`

---

## Privacidad

El servidor escucha en todas las interfaces de red, asi que sin proteccion
cualquiera conectado a la misma WiFi podria abrir el visor y ver tu camara. Por
eso hay una **clave de acceso** que se genera sola en el primer arranque y se
guarda en `certs/clave.txt`.

- Va incluida en el enlace del iPhone (`?c=...`) y despues queda en una cookie.
- Sin ella, cualquier peticion desde la red recibe un **401**, incluido el canal
  de senalizacion. Nadie puede ver la camara ni mandar ordenes al iPhone.
- El WebSocket comprueba ademas el `Origin`, para que una web abierta en otra
  pestana no pueda hablar con este servidor.
- **El PC no necesita clave**: las conexiones desde `127.0.0.1` estan exentas, por
  eso el estudio y la fuente de OBS se abren sin friccion.
- Lo unico accesible sin clave es `/certificado.crt`, que es solo la clave publica
  de la raiz y hay que poder descargarla antes de tener acceso.

Si crees que la clave se ha filtrado, borra `certs/clave.txt` y reinicia: se
generara otra y habra que volver a abrir el enlace nuevo en el iPhone.

## Como esta hecho

```
iniciar.bat          Lanzador
server.js            Servidor HTTPS + senalizacion WebRTC por WebSocket
certificados.js      Autoridad raiz estable + certificados de servidor
acceso.js            Clave de acceso y comprobacion de Origin
public/index.html    Estudio (PC)
public/viewer.js     Recepcion, controles remotos, guias, captura y grabacion
public/procesador.js Motor de color en WebGL (compartido por estudio y OBS)
public/phone.html    Capturador (iPhone)
public/phone.js      Camara, lentes, H.264, envio por WebRTC
public/obs.html      Salida limpia para la fuente de navegador de OBS
public/style.css     Estilos comunes
certs/ca.crt         Autoridad raiz. Esta es la que se instala en el iPhone
certs/servidor.crt   Certificado de servidor, se reemite al cambiar de red
certs/clave.txt      Clave de acceso
```

El iPhone captura con `getUserMedia` y envia por **WebRTC** directo al navegador
del PC. El servidor solo presenta a los dos extremos: **el video no pasa por el,
ni por internet**. Como la red va por USB, el recorrido fisico del video es el cable.

Admite **varias salidas a la vez** desde el mismo iPhone: el estudio, la fuente de
OBS y las pantallas extra que abras reciben cada una su propio flujo.

Puertos: **8443** (HTTPS, el iPhone) y **8080** (HTTP, estudio local, salida OBS y
descarga del certificado). Cambiarlos: `set HTTPS_PORT=9443` antes de `node server.js`.
