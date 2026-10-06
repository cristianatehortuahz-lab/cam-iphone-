# Nexo: guia para Claude

Proyecto personal: el iPhone como camara profesional del PC por cable USB-C, y el
montaje de directos de musica (cantar con Auto-Tune y producir) a YouTube y TikTok.
El usuario habla en espanol y no es programador: explica en llano, sin jerga.

Si este PC es nuevo y todavia no esta montado, lee primero
[INSTALAR-EN-OTRO-PC.md](INSTALAR-EN-OTRO-PC.md): el instalador es
`INSTALAR NEXO.bat` (`herramientas/instalar-nexo.ps1`). Las notas detalladas de
sesiones anteriores (medidas, causas de fallos, trampas) llegan en el kit privado
a la carpeta de memoria de Claude de este proyecto; esta guia es solo el mapa.

## Piezas

- `nexo-ios/`: Nexo Cam (Swift). Se compila en GitHub Actions
  (`.github/workflows/ios.yml`), que da un `.ipa` sin firmar. Se firma con
  Sideloadly y un Apple ID gratuito: caduca a los 7 dias.
  `instalar-guardian.bat` deja el daemon de Sideloadly vivo para que la renueve
  sola. Solo un PC debe firmar.
- `nexo-android/`: Nexo Cam para Android (Kotlin, Camera2 + MediaCodec, sin
  dependencias). Mismo protocolo y mismo puerto 7000 que la de iPhone. Se compila
  en GitHub Actions (`.github/workflows/android.yml`) y da un `.apk` que se instala
  tal cual. Solo por cable y solo apaisada. El movil necesita la "Depuracion por
  USB" activada.
- `nexo-desktop/`: Nexo Desktop (Electron).
  - Transporte usbmux en `127.0.0.1:27015` hacia el puerto 7000 del iPhone.
  - El cable hacia Android: `android.js`, con `adb forward` (adb en
    `herramientas/platform-tools/`, que no va en el repo). Cada Android es una
    camara mas, `cable-android-<serie>`.
  - Puente de audio ReaStream: `puente-audio.js`.
  - Salida del audio a VB-Cable para TikTok: `salida-audio.js`.
  - La camara como webcam de Windows: `camara-virtual.js` y su ayudante
    `src/nativo/camvirtual.cs` (Nexo lo compila solo con el `csc.exe` de Windows).
    Alimenta la "OBS Virtual Camera" sin que OBS este abierto; en las listas sale
    con ese nombre. Solo por cable. Giro, espejo y encuadre en el menu de la bandeja.
  - Micro del iPhone al directo: `micro-iphone.js` lo decodifica y el puente lo
    mezcla en el audio que ya va a OBS y a TikTok. Interruptor en la bandeja y en
    el estudio; apagado por defecto.
  - Un micro de OTRA interfaz hacia el DAW: `micro-windows.js` lo coge por Windows
    y el puente lo emite como un ReaStream aparte (`nexo-solo`), al paso de los
    paquetes del DAW. Una pista lo recibe con ReaStream en modo recibir (plantilla
    "Directo - dos voces", `herramientas/reaper/plantilla-dos-voces.js`). Se activa
    en `ajustes.json` > `microWindows`; apagado por defecto.
  - Ventana para TikTok (reserva, la via antigua): `herramientas/ventana-camara/`.
- `legado/`: servidor embebido. Sirve el estudio (puerto 8080) y la fuente de
  OBS (`/obs`). `/api/nexo` da el estado de Nexo, solo desde el propio PC.
- `herramientas/`: scripts de montaje, comprobacion y pruebas. El de cada dia es
  `iniciar-directo.ps1` (`INICIAR DIRECTO.bat`).
- `config-pc.json` (no esta en el repo): interfaz de audio y rutas de este PC.
  Lo escribe el instalador.

## Cadena de un directo

1. DAW: FL Studio para producir; Reaper con la plantilla "Directo - cantar" para
   cantar. Va por el ASIO de la interfaz, sin pasar por Windows.
2. En el Master, ReaStream (enviar, `nexo-fl`, `127.0.0.1`). El puente de Nexo lo
   reenvia por difusion local, asi que da igual el orden de arranque.
3. OBS (perfil y coleccion "Nexo Horizontal", escena "Estudio") va a YouTube:
   - la camara, con la fuente de navegador `localhost:8080/obs`;
   - el audio, con la fuente "FL Studio (ReaStream)".
4. TikTok LIVE Studio va a TikTok:
   - la camara, con una fuente "Camara" > "OBS Virtual Camera" (la alimenta Nexo).
     Las secuencias antiguas capturan la ventana "Nexo - Camara 1:1";
   - el audio, con el micro "CABLE Output" (VB-Cable), que alimenta Nexo.

## Trampas conocidas (no repetirlas)

- El driver ASIO de la interfaz solo admite UN programa. No abras FL dos veces ni
  FL y Reaper a la vez. `open_application` de computer-use abre una segunda
  instancia de FL. Para traerlo al frente usa
  `(New-Object -ComObject WScript.Shell).AppActivate(<PID>)`.
- Dos interfaces a la vez NO se juntan con ASIO4ALL: mete rafagas de ruido en la
  voz (medido el 04-05/10/2026, con el driver generico y con el de M-Audio). Se
  juntan con VoiceMeeter Banana: la principal por su ASIO (A1), la otra por WDM,
  cada micro a un lado del bus B1, y el DAW en "Voicemeeter Virtual ASIO" (entrada
  1 y 2 = los dos micros; su salida va a las dos interfaces). VoiceMeeter abierto
  ANTES que el DAW. Se maneja con `herramientas/voicemeeter.ps1`.
  `micro-windows.js` queda de reserva: llega al DAW ~55 ms tarde.
- FL: la entrada del Master en "In 1" mono, con "Monitorear la entrada externa:
  Activo". En "Cuando este armada" entra silencio tras abrir el proyecto.
- ASIO Link Pro esta en version de prueba y corta el sonido a proposito. No se usa.
  No ayudes a parchearlo.
- Los JSON de escenas de OBS se editan solo con OBS cerrado: los pisa al salir.
  Nunca toques `service.json` (clave de emision).
- TikTok LIVE Studio:
  - nunca pulses "Iniciar LIVE": lo pulsa el usuario;
  - su fuente "Enlace" no decodifica H.264;
  - su lista de ventanas es caprichosa: que una ventana no salga no prueba nada.
- Camara virtual:
  - una aplicacion que ya la tiene abierta conserva el tamano que negocio y
    deforma la imagen si cambia (formato del iPhone, giro, encuadre): hay que
    volver a elegir la camara en esa aplicacion;
  - TikTok la refleja y le aplica su retoque ("Mejorar") por su cuenta: lo que
    sale de Nexo es exacto (comprobado leyendola con ffmpeg);
  - si OBS inicia SU camara virtual, las dos se pisan: en este montaje no se usa;
  - a 4K este PC no da abasto (9 fps): el directo va a 720p;
  - con ffmpeg, ni `-fflags nobuffer` ni `-analyzeduration 0`: ver el comentario
    en `camara-virtual.js`.
- El micro del iPhone recoge tambien la voz sin Auto-Tune y los altavoces: con
  auriculares, y apagado cuando no haga falta. Sin DAW abierto el puente fabrica
  los paquetes; esa via no esta probada contra el ReaStream de OBS.
- `ajustes.json` de Nexo no se edita con PowerShell (`Out-File` mete BOM).
- Las capturas de pantalla de computer-use ocultan las aplicaciones que no estan
  permitidas (el navegador del usuario): pide acceso tambien a ellas o no captures
  mientras las usa.
- La ventana del estudio de Nexo gasta CPU: en un directo, a la bandeja.
- La ventana de Nexo usa `titleBarStyle` 'hidden', asi que no hay DevTools. Para
  cargar codigo nuevo del proceso principal hay que reiniciar Nexo. Su registro va
  a `%TEMP%\nexo-out.log` si se lanza con stdout redirigido.
- El PC original iba justo de CPU (Ryzen 5 7520U). Mide antes de dar algo por
  fluido: telemetria `[video] obs:` en el registro de Nexo, ffmpeg volumedetect
  en las grabaciones, contadores UDP.

## Estilo

- Comentarios y textos en espanol, sin tildes en el codigo. Explican el porque, con
  la medida o la fecha que lo justifica.
- Commits en espanol: el titulo describe el sintoma que se arregla.
- Sin framework de pruebas: scripts de prueba en `herramientas/`, y en la carpeta
  temporal las desechables.
