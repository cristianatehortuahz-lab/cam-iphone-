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
- `nexo-desktop/`: Nexo Desktop (Electron).
  - Transporte usbmux en `127.0.0.1:27015` hacia el puerto 7000 del iPhone.
  - Puente de audio ReaStream: `puente-audio.js`.
  - Salida del audio a VB-Cable para TikTok: `salida-audio.js`.
  - Ventana para TikTok: `herramientas/ventana-camara/`.
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
   - la camara, capturando la ventana "Nexo - Camara 1:1";
   - el audio, con el micro "CABLE Output" (VB-Cable), que alimenta Nexo.

## Trampas conocidas (no repetirlas)

- El driver ASIO de la interfaz solo admite UN programa. No abras FL dos veces ni
  FL y Reaper a la vez. `open_application` de computer-use abre una segunda
  instancia de FL. Para traerlo al frente usa
  `(New-Object -ComObject WScript.Shell).AppActivate(<PID>)`.
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
