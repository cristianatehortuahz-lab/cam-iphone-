# Llevar Nexo y el montaje de directos a otro PC

El código está en este repositorio. Lo personal (escenas de OBS, proyectos de FL,
plantilla de Reaper, la app del iPhone sin firmar y las notas de Claude) va en un
zip privado que **no se sube a GitHub**.

## En el PC viejo

1. Cierra OBS (guarda las escenas al cerrarse).
2. Exporta el kit:
   ```
   powershell -ExecutionPolicy Bypass -File herramientas\exportar-kit.ps1
   ```
   Deja `Nexo-kit-privado-AAAAMMDD-HHMM.zip` en el Escritorio.
3. Lleva ese zip al PC nuevo (USB, OneDrive, Drive).

## En el PC nuevo

1. Instala Git y clona el repositorio (la rama de trabajo es `arreglo-giro-ios`):
   ```
   git clone -b arreglo-giro-ios https://github.com/cristianatehortuahz-lab/cam-iphone-.git cawebfhone
   ```
2. Deja el zip del kit en el Escritorio o en Descargas.
3. Conecta la interfaz de audio (con su driver instalado) y el iPhone.
4. Abre Claude en la carpeta del proyecto y pídele que instale Nexo, o haz doble
   clic en **`INSTALAR NEXO.bat`**. El instalador:
   - comprueba requisitos e instala con winget los que se pueda (te pregunta antes);
   - instala las dependencias de Nexo (`npm ci`);
   - escribe `config-pc.json` con la interfaz y las rutas de este PC;
   - restaura el kit: OBS (con la fuente de ReaStream reapuntada a la interfaz
     nueva), FL, Reaper, la app del iPhone y las notas de Claude;
   - crea los accesos directos "Nexo" e "Iniciar directo";
   - termina con la lista de lo que falta.

   Se puede pasar varias veces: lo que ya existiera queda copiado con
   `.antes-nexo`. Con `-SoloComprobar` solo informa.

### Siempre a mano

- **Con licencia o driver**: FL Studio, Auto-Tune Artist, el driver ASIO de la
  interfaz, VB-Cable (como administrador), ReaPlugs x64 en
  `C:\Program Files\VSTPlugins`, Sideloadly y TikTok LIVE Studio.
- **OBS**: pegar de nuevo la clave de emisión (no viaja en el kit) y elegir el
  monitor de la fuente "Pantalla".
- **FL**: en el Master, entrada `In 1` en mono y "Monitorear la entrada externa:
  Activo". ReaStream en el último hueco: enviar, `nexo-fl`, `127.0.0.1`.
- **Reaper**: Preferences › Audio › ASIO con el driver de la interfaz, 44 100 Hz.
- **iPhone**: firmar `dist\Nexo-sin-firmar.ipa` con Sideloadly y tu Apple ID; luego
  doble clic en `instalar-guardian.bat` para que se renueve sola.
- **TikTok LIVE Studio**: iniciar sesión y montar las secuencias. La cámara de
  Nexo se añade como fuente "Cámara" > "OBS Virtual Camera" (con Nexo abierto y
  el iPhone por cable) y el audio es el micro "CABLE Output".
- **En el PC viejo**, cuando el nuevo ya firme la app:
  `herramientas\instalar-guardian.ps1 -Desinstalar`. Con un Apple ID gratuito,
  dos PCs firmando se invalidan la firma el uno al otro.

Después, el día a día es el acceso **"Iniciar directo"**.
