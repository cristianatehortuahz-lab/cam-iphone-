# Prepara el PC para un directo con un clic: libera recursos, abre todo en el
# orden correcto, lo coloca en su pantalla y comprueba lo que ya ha fallado
# otras veces. Al final deja una lista con lo que esta bien y lo que falta.
#
# Orden y por que:
#   1. Cerrar lo que sobra (el PC va justo: con todo abierto ronda el 80 % de CPU).
#   2. FL en el driver de la M-Audio. El de prueba de ASIO Link Pro corta el
#      sonido a proposito, y FL se ha vuelto a quedar en el alguna vez.
#   3. Nexo Desktop ANTES que FL y OBS: su puente de audio hace que OBS reciba a
#      FL arranque quien arranque primero, y saca el audio de FL por VB-Cable
#      para TikTok.
#   4. Ventana de la camara para TikTok, OBS (portatil), FL (monitor externo) y
#      TikTok LIVE Studio.
#   5. Esperar al iPhone y comprobar video, audio, firma de la app y CPU.
#   6. Mandar el estudio de Nexo a la bandeja: abierto gasta CPU sin hacer falta.
#
# No abre nada dos veces: si un programa ya esta abierto, lo deja como esta.
# (Abrir FL dos veces deja a la primera instancia sin la M-Audio.)
#
# Tres modos (pregunta al empezar si no se pasa -Modo):
#   Karaoke  : solo TikTok. Reaper (voz con Auto-Tune) + YouTube en Chrome con el
#              karaoke. TikTok capta el audio de Chrome; sin OBS.
#   Componer : YouTube (OBS) y TikTok. Reaper con el beat y la voz.
#   Producir : YouTube (OBS) y TikTok. FL Studio, como hasta ahora.
# Reaper y FL no pueden estar abiertos a la vez: el driver de la M-Audio solo
# admite un programa.
#
#   .\iniciar-directo.ps1                -> pregunta el modo y si cerrar
#                                           navegadores y juegos
#   .\iniciar-directo.ps1 -Modo Karaoke  -> sin preguntar el modo
#   .\iniciar-directo.ps1 -SinCerrar     -> no cierra nada
#   .\iniciar-directo.ps1 -SoloComprobar -> no abre ni cierra: solo revisa

[CmdletBinding()]
param(
  [ValidateSet('', 'Karaoke', 'Componer', 'Producir')][string]$Modo = '',
  [switch]$SinCerrar,
  [switch]$SoloComprobar,
  [switch]$Desatendido  # sin preguntas: modo Componer, no cierra navegadores ni juegos
)

$ErrorActionPreference = 'Continue'

# ------------------------------------------------------------------ ajustes --

$Raiz = Split-Path -Parent $PSScriptRoot

# Lo que cambia de un PC a otro (interfaz de audio, rutas, proyecto de FL) va en
# config-pc.json, en la raiz. Lo escribe herramientas\instalar-nexo.ps1. Sin el,
# valen los valores del PC donde nacio el montaje (M-Audio M-Track Solo/Duo).
$cfgPC = $null
$archivoCfg = Join-Path $Raiz 'config-pc.json'
if (Test-Path $archivoCfg) {
  try { $cfgPC = Get-Content $archivoCfg -Raw | ConvertFrom-Json }
  catch { Write-Host "  config-pc.json ilegible, uso los valores por defecto: $($_.Exception.Message)" -ForegroundColor Yellow }
}
function Valor($v, $defecto) { if ($null -ne $v -and "$v" -ne '') { $v } else { $defecto } }

$ProyectoFL = Valor $cfgPC.fl.proyecto (Join-Path $env:USERPROFILE 'Documents\Image-Line\FL Studio\Projects\lives 1\lives 1.flp')
$PerfilOBS = Valor $cfgPC.obs.perfil 'Nexo Horizontal'
$EscenaOBS = 'Estudio'
# Driver ASIO de la interfaz: lo usan FL y Reaper.
$DriverFL = Valor $cfgPC.interfaz.asio 'M-Audio M-Track Solo and Duo ASIO'
# Trozo del nombre de su entrada en Windows, para comprobar si esta colgada.
$EntradaInterfaz = Valor $cfgPC.interfaz.entradaWindows 'M-Track'
$ClaveRegistroFL = Valor $cfgPC.fl.claveRegistro 'HKCU:\Software\Image-Line\FL Studio 21\Devices\Audio output'

$Electron = Join-Path $Raiz 'node_modules\electron\dist\electron.exe'
$FLexe = Valor $cfgPC.fl.exe 'C:\Program Files\Image-Line\FL Studio 21\FL64.exe'
$ReaperExe = Valor $cfgPC.reaper.exe 'C:\Program Files\REAPER (x64)\reaper.exe'
$PlantillaReaper = Join-Path $env:APPDATA 'REAPER\ProjectTemplates\Directo - cantar.RPP'
$ChromeExe = Valor $cfgPC.chrome 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$OBSexe = Valor $cfgPC.obs.exe 'C:\Program Files\obs-studio\bin\64bit\obs64.exe'
$TikTokExe = Valor $cfgPC.tiktok 'C:\Program Files\TikTok LIVE Studio\TikTok LIVE Studio Launcher.exe'
$ApiNexo = 'http://localhost:8080/api/nexo'

# Programas de fondo que no pintan nada en un directo y no pierden datos al
# cerrarlos: se cierran sin preguntar.
$CerrarSiempre = @(
  'WhatsApp', 'WhatsApp.Root', 'Spotify', 'PhoneExperienceHost', 'CrossDeviceResume',
  'Widgets', 'EdgeGameAssist', 'ms-teams', 'Teams', 'Discord', 'steam', 'steamwebhelper',
  'RiotClientServices', 'Riot Client', 'ollama', 'ollama app', 'utweb', 'Notion', 'Canva',
  'Docker Desktop', 'SpotifyXboxGamebarWebView', 'Copilot', 'CapCut', 'Camo Studio'
)
# Navegadores y juegos: se pregunta antes, porque un juego puede perder la
# partida sin guardar (Stardew solo guarda al acabar el dia).
$CerrarPreguntando = @(
  'brave', 'chrome', 'msedge', 'opera', 'firefox',
  'Stardew Valley', 'League of Legends', 'javaw', 'NMS', 'Dishonored'
)

# ------------------------------------------------------------- utilidades --

$resumen = New-Object System.Collections.Generic.List[object]
function Anotar([string]$estado, [string]$que, [string]$detalle = '') {
  $resumen.Add([pscustomobject]@{ Estado = $estado; Que = $que; Detalle = $detalle })
  $color = switch ($estado) { 'OK' { 'Green' } 'AVISO' { 'Yellow' } default { 'Red' } }
  Write-Host ("  [{0,-5}] {1}" -f $estado, $que) -ForegroundColor $color -NoNewline
  if ($detalle) { Write-Host " - $detalle" } else { Write-Host '' }
}
function Paso([string]$texto) { Write-Host ''; Write-Host "== $texto" -ForegroundColor Cyan }

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class Ventanas {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  // Primera ventana visible cuyo titulo contenga 'titulo' (y de la clase pedida, si se pide).
  public static IntPtr Buscar(string titulo, string clase) {
    IntPtr res = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (t.ToString().Contains(titulo) && (clase == null || c.ToString() == clase)) { res = h; return false; }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

function Esperar-Ventana([string]$titulo, [string]$clase = $null, [int]$segundos = 40) {
  $fin = (Get-Date).AddSeconds($segundos)
  do {
    $h = [Ventanas]::Buscar($titulo, $clase)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $fin)
  return [IntPtr]::Zero
}

# Restaura la ventana, la lleva a la pantalla pedida y la maximiza.
function Colocar([IntPtr]$h, $pantalla) {
  if ($h -eq [IntPtr]::Zero -or -not $pantalla) { return }
  $a = $pantalla.WorkingArea
  [Ventanas]::ShowWindow($h, 9) | Out-Null
  Start-Sleep -Milliseconds 300
  [Ventanas]::SetWindowPos($h, [IntPtr]::Zero, $a.X + 40, $a.Y + 40, [Math]::Min(1200, $a.Width - 80), [Math]::Min(700, $a.Height - 80), 0x0004) | Out-Null
  Start-Sleep -Milliseconds 300
  [Ventanas]::ShowWindow($h, 3) | Out-Null
}

function Estado-Nexo {
  try { return Invoke-RestMethod $ApiNexo -TimeoutSec 3 } catch { return $null }
}

function Nexo-Abierto {
  [bool](Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*cawebfhone\node_modules\electron\dist\electron.exe*' -and
                   $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*ventana-camara*' })
}

function Camara-Abierta {
  [bool](Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*ventana-camara*' -and $_.CommandLine -notlike '*--type=*' })
}

$pantallas = [System.Windows.Forms.Screen]::AllScreens
$portatil = $pantallas | Where-Object Primary | Select-Object -First 1
$externa = $pantallas | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $externa) { $externa = $portatil }

Write-Host ''
Write-Host '  NEXO - Preparando el directo' -ForegroundColor White
Write-Host '  ============================' -ForegroundColor White

if (-not $Modo) {
  if ($Desatendido -or $SoloComprobar) { $Modo = 'Componer' }
  else {
    Write-Host ''
    Write-Host '  1) Karaoke   - solo TikTok: Reaper (voz) + karaoke de YouTube en Chrome'
    Write-Host '  2) Componer  - YouTube y TikTok: Reaper con el beat y la voz'
    Write-Host '  3) Producir  - YouTube y TikTok: FL Studio'
    $r = Read-Host '  Modo? (1/2/3, Enter = 2)'
    $Modo = switch ($r.Trim()) { '1' { 'Karaoke' } '3' { 'Producir' } default { 'Componer' } }
  }
}
$UsaOBS = $Modo -ne 'Karaoke'
$UsaReaper = $Modo -ne 'Producir'
Write-Host "  Modo: $Modo" -ForegroundColor Cyan
# En karaoke el navegador es parte del directo: no se cierra.
if ($Modo -eq 'Karaoke') { $CerrarPreguntando = $CerrarPreguntando | Where-Object { $_ -notin 'brave', 'chrome', 'msedge', 'opera', 'firefox' } }

# ----------------------------------------------------- 1. liberar recursos --

if (-not $SinCerrar -and -not $SoloComprobar) {
  Paso 'Liberando recursos'

  function Cerrar-Procesos([string[]]$nombres) {
    $cerrados = @()
    foreach ($nombre in $nombres) {
      $ps = @(Get-Process -Name $nombre -ErrorAction SilentlyContinue)
      if (-not $ps) { continue }
      # Primero como si pulsaras la X: guardan lo que tengan que guardar.
      foreach ($p in $ps) { if ($p.MainWindowHandle -ne 0) { $p.CloseMainWindow() | Out-Null } }
      $cerrados += $nombre
    }
    if (-not $cerrados) { return @() }
    Start-Sleep -Seconds 4
    # Lo que siga vivo (procesos de fondo sin ventana), se termina.
    foreach ($nombre in $cerrados) {
      Get-Process -Name $nombre -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    return $cerrados
  }

  $hechos = Cerrar-Procesos $CerrarSiempre
  if ($hechos) { Anotar 'OK' 'Cerrados programas de fondo' ($hechos -join ', ') }
  else { Anotar 'OK' 'No habia programas de fondo que cerrar' }

  $abiertos = @($CerrarPreguntando | Where-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue })
  if ($abiertos) {
    $cerrar = $false
    if (-not $Desatendido) {
      Write-Host ''
      Write-Host "  Abiertos: $($abiertos -join ', ')" -ForegroundColor Yellow
      Write-Host '  Los navegadores recuperan sus pestanas al volver a abrirlos.'
      Write-Host '  Un juego puede perder lo no guardado.'
      $r = Read-Host '  Cerrarlos para liberar memoria y CPU? (S/N)'
      $cerrar = $r -match '^[sSyY]'
    }
    if ($cerrar) { $hechos = Cerrar-Procesos $abiertos; Anotar 'OK' 'Cerrados navegadores y juegos' ($hechos -join ', ') }
    else { Anotar 'AVISO' 'Siguen abiertos (gastan recursos)' ($abiertos -join ', ') }
  }
}

# ------------------------------------------- 2. DAW y driver de audio ------

# El otro DAW tiene que estar cerrado: los dos a la vez se pelean por la M-Audio
# y el que llegue segundo se queda sin entradas.
function Cerrar-Daw([string]$proceso, [string]$nombre) {
  $p = Get-Process $proceso -ErrorAction SilentlyContinue | Where-Object MainWindowHandle
  if (-not $p) { return $true }
  if ($SoloComprobar) { Anotar 'FALLO' "$nombre esta abierto" 'cierralo: ocupa la M-Audio'; return $false }
  $cerrar = $Desatendido
  if (-not $Desatendido) {
    $r = Read-Host "  $nombre esta abierto y ocupa la M-Audio. Lo cierro? (te pedira guardar si hace falta) (S/N)"
    $cerrar = $r -match '^[sSyY]'
  }
  if (-not $cerrar) { Anotar 'FALLO' "$nombre sigue abierto" 'cierralo: ocupa la M-Audio'; return $false }
  foreach ($x in $p) { $x.CloseMainWindow() | Out-Null }
  $fin = (Get-Date).AddSeconds(30)
  do { Start-Sleep -Seconds 1 } while ((Get-Process $proceso -ErrorAction SilentlyContinue) -and (Get-Date) -lt $fin)
  if (Get-Process $proceso -ErrorAction SilentlyContinue) { Anotar 'FALLO' "$nombre no se cerro" 'quiza espera a que guardes: miralo'; return $false }
  Anotar 'OK' "$nombre cerrado"
  return $true
}

if ($UsaReaper) {
  Paso 'Audio de Reaper'
  Cerrar-Daw 'FL64' 'FL Studio' | Out-Null
  $ini = Join-Path $env:APPDATA 'REAPER\reaper.ini'
  $cfg = Get-Content $ini -ErrorAction SilentlyContinue
  if (($cfg -match '^mode=3$') -and ($cfg -match [regex]::Escape("asio_driver_name=`"$DriverFL`""))) { Anotar 'OK' 'Reaper usa el driver de la M-Audio' }
  else { Anotar 'FALLO' 'Reaper no esta en el driver de la M-Audio' "Options > Preferences > Audio > Device: ASIO, $DriverFL" }
  if (Test-Path $PlantillaReaper) { Anotar 'OK' 'Plantilla de Reaper "Directo - cantar"' }
  else { Anotar 'FALLO' 'Falta la plantilla de Reaper' 'herramientas\reaper\crear-plantilla-directo.lua' }
} else {
  Paso 'Audio de FL Studio'
  Cerrar-Daw 'reaper' 'Reaper' | Out-Null
  $claveFL = $ClaveRegistroFL
  $flAbierto = [bool](Get-Process FL64 -ErrorAction SilentlyContinue)
  $driver = (Get-ItemProperty $claveFL -ErrorAction SilentlyContinue).'Device name'
  $ventanaPrueba = [Ventanas]::Buscar('ASIO Link Pro', $null)
  if ($flAbierto -and $ventanaPrueba -ne [IntPtr]::Zero) {
    Anotar 'FALLO' 'FL esta usando ASIO Link Pro (version de prueba: corta el sonido)' "En FL: F10 > Audio > Dispositivo > $DriverFL"
  } elseif (-not $flAbierto -and $driver -ne "1$DriverFL") {
    if (-not $SoloComprobar) {
      Set-ItemProperty $claveFL -Name 'Device name' -Value "1$DriverFL"
      Anotar 'OK' 'Driver de FL corregido a la M-Audio' "estaba en '$($driver -replace '^1','')'"
    } else {
      Anotar 'FALLO' 'FL arrancara con el driver equivocado' ($driver -replace '^1', '')
    }
  } else {
    Anotar 'OK' 'FL usa el driver de la M-Audio'
  }
}

# ---------------------------------------------------------- 3. Nexo --------

Paso 'Nexo Desktop'
if (-not (Nexo-Abierto)) {
  if ($SoloComprobar) {
    Anotar 'FALLO' 'Nexo Desktop no esta abierto'
  } else {
    Start-Process -FilePath $Electron -ArgumentList '.' -WorkingDirectory (Join-Path $Raiz 'nexo-desktop') `
      -RedirectStandardOutput "$env:TEMP\nexo-out.log" -RedirectStandardError "$env:TEMP\nexo-err.log"
    Write-Host '  abriendo Nexo...'
  }
}
$fin = (Get-Date).AddSeconds(40)
do { $nexo = Estado-Nexo; if (-not $nexo) { Start-Sleep -Seconds 1 } } while (-not $nexo -and (Get-Date) -lt $fin)
if ($nexo) { Anotar 'OK' 'Nexo Desktop en marcha' } else { Anotar 'FALLO' 'Nexo no responde' 'mira %TEMP%\nexo-err.log' }

# ------------------------------------------- 4. ventanas: camara, OBS, FL ---

if (-not $SoloComprobar -and $nexo) {
  Paso 'Abriendo programas'

  # Ventana de la camara que captura TikTok. Va al portatil, debajo de OBS: puede
  # quedar tapada, pero no minimizada.
  if (-not (Camara-Abierta)) {
    Start-Process -FilePath $Electron -ArgumentList "`"$(Join-Path $Raiz 'herramientas\ventana-camara\main.js')`"", '1:1'
    $h = Esperar-Ventana 'Nexo - Camara' $null 20
    if ($h -ne [IntPtr]::Zero) {
      $a = $portatil.WorkingArea
      [Ventanas]::SetWindowPos($h, [IntPtr]::Zero, $a.X + 20, $a.Y + 20, 0, 0, 0x0001 -bor 0x0004) | Out-Null
    }
  }
  if (Camara-Abierta) { Anotar 'OK' 'Ventana de la camara para TikTok' } else { Anotar 'FALLO' 'No se abrio la ventana de la camara' }

  if ($UsaOBS) {
    if (-not (Get-Process obs64 -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $OBSexe -WorkingDirectory (Split-Path $OBSexe) `
        -ArgumentList "--profile `"$PerfilOBS`" --collection `"$PerfilOBS`" --scene `"$EscenaOBS`" --disable-shutdown-check"
      Colocar (Esperar-Ventana 'OBS ' 'Qt6111QWindowIcon' 40) $portatil
    }
    if (Get-Process obs64 -ErrorAction SilentlyContinue) { Anotar 'OK' "OBS ($PerfilOBS, escena $EscenaOBS)" } else { Anotar 'FALLO' 'OBS no se abrio' }
  }

  if ($UsaReaper) {
    if (-not (Get-Process reaper -ErrorAction SilentlyContinue)) {
      # -template: abre la plantilla como proyecto nuevo, sin tocar el original.
      Start-Process -FilePath $ReaperExe -ArgumentList '-template', "`"$PlantillaReaper`""
      Write-Host '  abriendo Reaper (si sale el aviso de la licencia de evaluacion, cierralo)...'
      Colocar (Esperar-Ventana 'REAPER' 'REAPERwnd' 40) $externa
    }
    if (Get-Process reaper -ErrorAction SilentlyContinue) { Anotar 'OK' 'Reaper (plantilla Directo - cantar)' } else { Anotar 'FALLO' 'Reaper no se abrio' }
  } else {
    if (-not (Get-Process FL64 -ErrorAction SilentlyContinue)) {
      if (Test-Path $ProyectoFL) { Start-Process -FilePath $FLexe -ArgumentList "`"$ProyectoFL`"" }
      else { Start-Process -FilePath $FLexe; Anotar 'AVISO' 'No encuentro el proyecto de FL' $ProyectoFL }
      Write-Host '  abriendo FL Studio (tarda un poco)...'
      $h = Esperar-Ventana 'FL Studio' 'TFruityLoopsMainForm' 90
      Start-Sleep -Seconds 3
      Colocar $h $externa
    }
    if (Get-Process FL64 -ErrorAction SilentlyContinue) { Anotar 'OK' 'FL Studio' (Split-Path $ProyectoFL -Leaf) } else { Anotar 'FALLO' 'FL no se abrio' }
  }

  # Karaoke: YouTube en el Chrome del usuario (su cuenta Premium: sin anuncios en
  # el directo). TikTok captura esa ventana, y su sonido por la fuente de audio
  # "Dispositivo predeterminado" (la salida de Windows, con 150 ms de desfase).
  # La ventana va SIN maximizar en el monitor externo, que es como TikTok la
  # ofrecio en su lista (01/10/2026); maximizada no aparecia. Y nunca minimizada:
  # TikTok se queda con el ultimo fotograma.
  if ($Modo -eq 'Karaoke') {
    if (-not (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object MainWindowHandle)) {
      if (Test-Path $ChromeExe) {
        Start-Process -FilePath $ChromeExe -ArgumentList '--new-window', 'https://www.youtube.com/results?search_query=karaoke'
        $h = Esperar-Ventana 'Google Chrome' $null 30
        if ($h -ne [IntPtr]::Zero) {
          $a = $externa.WorkingArea
          [Ventanas]::ShowWindow($h, 9) | Out-Null
          Start-Sleep -Milliseconds 300
          [Ventanas]::SetWindowPos($h, [IntPtr]::Zero, $a.X + 60, $a.Y + 60, [Math]::Min(1280, $a.Width - 120), [Math]::Min(760, $a.Height - 120), 0x0004) | Out-Null
        }
      }
    }
    if (Get-Process chrome -ErrorAction SilentlyContinue) { Anotar 'OK' 'Chrome para el karaoke' 'no lo minimices: TikTok dejaria de verlo' }
    else { Anotar 'FALLO' 'Chrome no se abrio' }
  }

  if (-not (Get-Process 'TikTok LIVE Studio' -ErrorAction SilentlyContinue)) {
    if (Test-Path $TikTokExe) { Start-Process -FilePath $TikTokExe; Start-Sleep -Seconds 5 }
  }
  if (Get-Process 'TikTok LIVE Studio' -ErrorAction SilentlyContinue) { Anotar 'OK' 'TikTok LIVE Studio' } else { Anotar 'AVISO' 'TikTok LIVE Studio no esta abierto' }
}

# --------------------------------------------------- 5. comprobaciones -----

Paso 'Comprobando'

# iPhone
$nexo = Estado-Nexo
if ($nexo -and -not ($nexo.iphone.conectado -and $nexo.iphone.transmitiendo)) {
  Write-Host '  >> Abre Nexo Cam en el iPhone y dejala en pantalla (esperando hasta 90 s)...' -ForegroundColor Yellow
  $fin = (Get-Date).AddSeconds(90)
  do { Start-Sleep -Seconds 2; $nexo = Estado-Nexo } while ($nexo -and -not ($nexo.iphone.conectado -and $nexo.iphone.transmitiendo) -and (Get-Date) -lt $fin)
}
if ($nexo -and $nexo.iphone.conectado -and $nexo.iphone.transmitiendo) {
  # Nexo Cam arranca en 4K y a los pocos segundos el estudio le aplica la
  # calidad que elegiste: se espera a eso antes de juzgarla.
  Start-Sleep -Seconds 8
  $nexo = Estado-Nexo
  $res = $nexo.iphone.resolucionReal
  $lado = ($res -split 'x' | ForEach-Object { [int]$_ } | Measure-Object -Maximum).Maximum
  # La app del iPhone puede colgarse con el video todavia saliendo: deja de
  # atender ordenes (01/10/2026). Solo se arregla cerrandola en el movil.
  if ($nexo.iphone.responde -eq $false) { Anotar 'FALLO' 'El iPhone emite pero no atiende ordenes' 'cierra Nexo Cam en el iPhone y vuelve a abrirla' }
  elseif ($lado -le 1280) { Anotar 'OK' 'iPhone emitiendo por cable' "$res a $($nexo.iphone.fps) fps" }
  else { Anotar 'AVISO' 'iPhone emitiendo, pero en alta resolucion' "${res}: el PC va justo, elige 720p en el estudio de Nexo" }
} elseif ($nexo -and $nexo.iphone.hayCable) {
  Anotar 'FALLO' 'iPhone conectado pero sin emitir' 'abre Nexo Cam y dejala en pantalla'
} else {
  Anotar 'FALLO' 'No hay iPhone' 'conectalo por cable USB-C y desbloquealo'
}

# Audio de FL: llega, sin silencios, centrado
if ($nexo -and $nexo.audioFL.llega) {
  $audio = node (Join-Path $Raiz 'herramientas\comprobar-audio.js') 4 | ConvertFrom-Json
  if ($audio.error) {
    Anotar 'AVISO' 'No pude medir el audio' $audio.error
  } elseif ($audio.segundosSilencio -ge 2) {
    Anotar 'FALLO' 'FL manda silencio absoluto' 'Master > entrada In 1 > Monitorear la entrada externa: Activo (y driver de la M-Audio)'
  } elseif ([math]::Max([double]$audio.nivelL, [double]$audio.nivelR) -lt -80) {
    # Con el micro enchufado, solo el ruido de la sala ya ronda -60 dB; -90 es
    # que a la M-Audio no le llega nada (medido el 30/09/2026).
    Anotar 'FALLO' 'El micro no llega a la M-Audio' 'revisa el cable en la entrada 1, la ganancia de In 1 y el boton 48V si es de condensador'
  } elseif ($audio.desequilibrioDb -ge 3) {
    Anotar 'FALLO' "Audio descompensado ($($audio.desequilibrioDb) dB entre canales)" 'Master > entrada: In 1 en MONO, no "In 1 - In 2"'
  } else {
    Anotar 'OK' 'Audio de FL llega a OBS y TikTok' "nivel $($audio.nivelL) dB, centrado"
  }
} elseif ($nexo) {
  # Sin paquetes puede ser que la M-Audio este "colgada": Windows la ve conectada
  # pero no entrega audio ni al DAW ni a nadie (paso el 01/10/2026; se arreglo
  # desenchufandola). Se distingue leyendo 1 s de su entrada: si no vuelve, es eso.
  $colgada = $null
  $ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
  # La entrada de la interfaz, no su salida: los altavoces no se pueden leer con dshow.
  $entrada = (Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match [regex]::Escape($EntradaInterfaz) -and
                   $_.FriendlyName -notmatch '^(Altavoces|Speakers|Auriculares|Headphones|Salida|Output)' } |
    Select-Object -First 1).FriendlyName
  if ($ff -and $entrada) {
    $p = Start-Process -FilePath $ff -PassThru -WindowStyle Hidden `
      -ArgumentList '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', "`"audio=$entrada`"", '-t', '1', '-f', 'null', 'NUL'
    if ($p.WaitForExit(8000)) { $colgada = $false } else { try { $p.Kill() } catch {}; $colgada = $true }
  }
  if ($colgada) {
    Anotar 'FALLO' 'La M-Audio no entrega audio (esta colgada)' 'desenchufa su USB, espera 5 s y vuelve a enchufarla; luego reabre Reaper o FL'
  } elseif ($UsaReaper) {
    Anotar 'FALLO' 'No llega audio de Reaper' 'cierra el aviso de licencia si sigue abierto; Master: ReaStream enviando, nexo-fl, 127.0.0.1'
  } else {
    Anotar 'FALLO' 'No llega audio de FL' 'Master de FL: ReaStream en el ultimo hueco, enviar, nexo-fl, 127.0.0.1'
  }
}
if ($nexo -and $nexo.salidaTikTok.activa) { Anotar 'OK' 'Audio para TikTok por VB-Cable' $nexo.salidaTikTok.dispositivo }
elseif ($nexo) { Anotar 'AVISO' 'Sin salida de audio para TikTok' 'falta VB-Cable (CABLE Input)' }

# --- La camara como webcam (fuente "Camara" de TikTok) y el micro del iPhone ---
$cam = if ($nexo) { $nexo.camaraVirtual } else { $null }
if ($cam -and $cam.activa) {
  if ($cam.enMarcha) { Anotar 'OK' 'Camara de Nexo como webcam' "$($cam.tamano): en TikTok, fuente Camara > OBS Virtual Camera" }
  elseif ($cam.motivo) { Anotar 'AVISO' 'La camara de Nexo no sale como webcam' $cam.motivo }
  else { Anotar 'AVISO' 'La camara de Nexo espera al iPhone por cable' }
}
# Encendido por descuido mete en el directo la voz sin Auto-Tune y lo que suene
# por los altavoces: que se vea antes de emitir.
if ($nexo -and $nexo.microIphone -and $nexo.microIphone.activo) {
  Anotar 'AVISO' 'El micro del iPhone esta ENCENDIDO en el directo' 'se apaga en el icono de Nexo (bandeja) > Micro del iPhone al directo'
}

# Firma de la app del iPhone
$firma = node (Join-Path $Raiz 'herramientas\caducidad-firma.js') | ConvertFrom-Json
if ($firma.error) { Anotar 'AVISO' 'No pude leer la firma del iPhone' $firma.error }
elseif ($firma.horasRestantes -lt 0) { Anotar 'FALLO' 'La app del iPhone esta caducada' 'vuelve a firmarla con Sideloadly' }
elseif ($firma.horasRestantes -lt 48) { Anotar 'AVISO' "La firma caduca en $($firma.horasRestantes) h" 'deja el iPhone por cable: se renueva sola' }
else { Anotar 'OK' 'Firma del iPhone' "le quedan $([math]::Floor($firma.horasRestantes / 24)) dias" }

# ------------------------------------------------ 6. ultimos ajustes -------

if (-not $SoloComprobar) {
  # Estudio de Nexo a la bandeja. Con "cerrar va a la bandeja" la X lo oculta;
  # si no, se minimiza (cerrarlo cerraria Nexo entero).
  $h = [Ventanas]::Buscar('Camara iPhone - Estudio', $null)
  if ($h -ne [IntPtr]::Zero) {
    $ajustes = Get-Content (Join-Path $env:APPDATA 'nexo-desktop\ajustes.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($ajustes -and $ajustes.cerrarVaABandeja) { [Ventanas]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    else { [Ventanas]::ShowWindow($h, 6) | Out-Null }
    Anotar 'OK' 'Estudio de Nexo a la bandeja (ahorra CPU)'
  }
  # El DAW primero: un corte en el audio se oye; un fotograma de menos, no.
  foreach ($p in @(Get-Process FL64, reaper -ErrorAction SilentlyContinue)) { try { $p.PriorityClass = 'High' } catch {} }
}

$cpu = 1..5 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep -Milliseconds 600 }
$media = [math]::Round(($cpu | Measure-Object -Average).Average)
$ram = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
if ($media -ge 90) { Anotar 'AVISO' "CPU al $media % sin emitir" 'cierra lo que no uses; si TikTok pierde FPS, bajale la calidad' }
else { Anotar 'OK' "CPU al $media %, RAM libre $ram GB" }

# ----------------------------------------------------------------- resumen --

$fallos = @($resumen | Where-Object Estado -eq 'FALLO')
$avisos = @($resumen | Where-Object Estado -eq 'AVISO')
Write-Host ''
if ($fallos) {
  Write-Host '  FALTA ARREGLAR ANTES DE SALIR EN DIRECTO:' -ForegroundColor Red
  foreach ($f in $fallos) { Write-Host "   - $($f.Que): $($f.Detalle)" -ForegroundColor Red }
} else {
  Write-Host '  TODO LISTO.' -ForegroundColor Green
  switch ($Modo) {
    'Karaoke' {
      Write-Host '  En TikTok elige la escena "Karaoke", pon el karaoke en Chrome y pulsa "Iniciar LIVE".' -ForegroundColor Green
      Write-Host '  Chrome tiene que sonar por la M-Audio para que lo oigas en los auriculares.' -ForegroundColor Green
    }
    'Componer' {
      Write-Host '  Arrastra el beat a la pista "Beat" de Reaper.' -ForegroundColor Green
      Write-Host '  En TikTok elige la escena "Componer". Luego "Iniciar transmision" en OBS e "Iniciar LIVE" en TikTok.' -ForegroundColor Green
    }
    default {
      Write-Host '  Pulsa "Iniciar transmision" en OBS (YouTube) e "Iniciar LIVE" en TikTok.' -ForegroundColor Green
    }
  }
}
if ($avisos) {
  Write-Host '  Avisos:' -ForegroundColor Yellow
  foreach ($a in $avisos) { Write-Host "   - $($a.Que): $($a.Detalle)" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  Recuerda: no cierres la ventana "Nexo - Camara 1:1" (TikTok dejaria de verla).'
Write-Host '  Si en TikTok la camara sale en negro o en blanco: engranaje de "electron.exe" >'
Write-Host '  Seleccionar programa > "electron.exe Nexo - Camara 1:1" > Aplicar.'
Write-Host ''
