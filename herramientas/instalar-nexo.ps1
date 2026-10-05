# Instala Nexo y el montaje de directos en un PC nuevo. Pensado para hacerlo con
# Claude abierto en la carpeta del proyecto (ver CLAUDE.md), que lee la salida y
# ayuda con lo que quede pendiente.
#
# Que hace, en orden:
#   1. Requisitos: comprueba programas; los que hay en winget los instala si le
#      dices que si. Los de licencia o con driver (FL Studio, Auto-Tune, driver de
#      la interfaz, VB-Cable, ReaPlugs, Sideloadly, TikTok LIVE Studio) solo los
#      comprueba y da el enlace: se instalan a mano.
#   2. Dependencias de Nexo (npm).
#   3. config-pc.json: interfaz de audio y rutas de ESTE PC, para iniciar-directo.
#   4. Kit privado (Nexo-kit-privado-*.zip, lo crea exportar-kit.ps1 en el PC
#      viejo): escenas y perfiles de OBS reapuntados a la interfaz nueva,
#      proyectos de FL, plantilla de Reaper, app del iPhone y notas de Claude.
#   5. Driver de FL en el registro, si FL ya se abrio alguna vez y esta cerrado.
#   6. Accesos directos en el Escritorio.
#   7. Lista de lo que falta, para hacerlo a mano o con Claude.
#
# No sobrescribe nada sin copia: lo que ya existiera queda con ".antes-nexo".
#
#   .\instalar-nexo.ps1                      -> busca el kit en Escritorio y Descargas
#   .\instalar-nexo.ps1 -Kit D:\kit.zip      -> kit en otra ruta
#   .\instalar-nexo.ps1 -SoloComprobar       -> no instala ni copia: solo informa
#   .\instalar-nexo.ps1 -Interfaz 'M-Track'  -> otra interfaz (por defecto AIR 192)

[CmdletBinding()]
param(
  [string]$Kit = '',
  [string]$Interfaz = 'AIR 192',
  [switch]$SoloComprobar
)

$ErrorActionPreference = 'Continue'
$Raiz = Split-Path -Parent $PSScriptRoot

$pendiente = New-Object System.Collections.Generic.List[string]
function Anotar([string]$estado, [string]$que, [string]$detalle = '') {
  $color = switch ($estado) { 'OK' { 'Green' } 'AVISO' { 'Yellow' } default { 'Red' } }
  Write-Host ("  [{0,-5}] {1}" -f $estado, $que) -ForegroundColor $color -NoNewline
  if ($detalle) { Write-Host " - $detalle" } else { Write-Host '' }
  if ($estado -ne 'OK') { $pendiente.Add("$que$(if ($detalle) { ": $detalle" })") }
}
function Paso([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
# Con -SoloComprobar no se copia nada: los "OK" del kit dicen lo que se copiaria.
$copia = if ($SoloComprobar) { ' (se copiaria; ahora solo compruebo)' } else { '' }
function Preguntar([string]$t) { if ($SoloComprobar) { return $false }; (Read-Host "  $t (S/N)") -match '^[sS]' }
# Copia sin perder lo que hubiera: lo existente pasa a <nombre>.antes-nexo.
function Copiar-Seguro([string]$origen, [string]$destino) {
  if ($SoloComprobar) { return }
  New-Item -ItemType Directory -Force (Split-Path $destino) | Out-Null
  if (Test-Path -LiteralPath $destino) {
    $copia = "$destino.antes-nexo"
    if (-not (Test-Path -LiteralPath $copia)) { Copy-Item -LiteralPath $destino -Destination $copia -Recurse -Force }
  }
  if ((Get-Item -LiteralPath $origen).PSIsContainer) {
    # Carpeta: se copia su CONTENIDO. Copy-Item con el destino ya creado meteria
    # la carpeta dentro de si misma (profiles\Nexo Horizontal\Nexo Horizontal).
    New-Item -ItemType Directory -Force $destino | Out-Null
    Get-ChildItem -LiteralPath $origen -Force | Copy-Item -Destination $destino -Recurse -Force
  } else {
    Copy-Item -LiteralPath $origen -Destination $destino -Force
  }
}
function Primero([string[]]$rutas) { $rutas | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1 }

Write-Host ''
Write-Host '  NEXO - instalacion en este PC' -ForegroundColor Cyan
Write-Host "  Proyecto: $Raiz"

# ------------------------------------------------------------ 1. Requisitos --

Paso 'Requisitos'
$conWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
function Hay-Puerto([int]$p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

$requisitos = @(
  @{ Nombre = 'Git'; Hay = { [bool](Get-Command git -ErrorAction SilentlyContinue) }; Winget = 'Git.Git' },
  # node:sqlite (caducidad-firma.js) necesita Node 22.5 o mas.
  @{ Nombre = 'Node.js 22 o mas'; Hay = { (& node -v 2>$null) -match '^v(2[2-9]|[3-9]\d)\.' }; Winget = 'OpenJS.NodeJS.LTS' },
  @{ Nombre = 'OBS Studio'; Hay = { Test-Path 'C:\Program Files\obs-studio\bin\64bit\obs64.exe' }; Winget = 'OBSProject.OBSStudio' },
  @{ Nombre = 'FFmpeg'; Hay = { [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue) }; Winget = 'Gyan.FFmpeg' },
  @{ Nombre = 'REAPER'; Hay = { Test-Path 'C:\Program Files\REAPER (x64)\reaper.exe' }; Winget = 'Cockos.REAPER' },
  @{ Nombre = 'Google Chrome'; Hay = { Test-Path 'C:\Program Files\Google\Chrome\Application\chrome.exe' }; Winget = 'Google.Chrome' },
  # usbmux de Apple (puerto 27015): sin el, Nexo no ve el iPhone por cable.
  @{ Nombre = 'Servicio de Apple para el iPhone (iTunes)'; Hay = { (Hay-Puerto 27015) -or [bool](Get-Service 'Apple Mobile Device Service' -ErrorAction SilentlyContinue) }; Winget = 'Apple.iTunes' }
)
$faltan = @()
foreach ($r in $requisitos) {
  if (& $r.Hay) { Anotar 'OK' $r.Nombre } else { $faltan += $r }
}
if ($faltan) {
  foreach ($r in $faltan) { Write-Host "  [FALTA] $($r.Nombre)" -ForegroundColor Yellow }
  if ($conWinget -and (Preguntar "Instalo con winget lo que falta? Te pedira aceptar sus licencias")) {
    foreach ($r in $faltan) {
      Write-Host "  instalando $($r.Nombre)..."
      winget install --id $r.Winget -e
    }
    # Lo recien instalado no esta en el PATH de esta ventana.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  foreach ($r in $faltan) {
    if (& $r.Hay) { Anotar 'OK' "$($r.Nombre) (recien instalado)" }
    else { Anotar 'FALTA' $r.Nombre "winget install --id $($r.Winget) -e" }
  }
}

# Los de licencia, driver o sin winget: se comprueban y se da el enlace.
$flExe = Primero ((Get-ChildItem 'C:\Program Files\Image-Line' -Directory -Filter 'FL Studio*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'FL64.exe' }))
if ($flExe) { Anotar 'OK' 'FL Studio' $flExe } else { Anotar 'FALTA' 'FL Studio' 'instalalo con tu cuenta de image-line.com' }

$autoTune = Get-ChildItem 'C:\Program Files\Common Files\VST3', 'C:\Program Files\VSTPlugins' -Recurse -Filter '*Auto-Tune*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($autoTune) { Anotar 'OK' 'Auto-Tune' $autoTune.Name } else { Anotar 'FALTA' 'Auto-Tune Artist' 'instalalo y activalo con tu cuenta de Antares' }

$asio = Get-ChildItem 'HKLM:\SOFTWARE\ASIO' -ErrorAction SilentlyContinue | ForEach-Object PSChildName
$driverAsio = $asio | Where-Object { $_ -match [regex]::Escape($Interfaz) } | Select-Object -First 1
if ($driverAsio) { Anotar 'OK' "Driver ASIO de la interfaz" $driverAsio }
else { Anotar 'FALTA' "Driver ASIO de la interfaz ($Interfaz)" 'm-audio.com/support/downloads; luego conecta la interfaz y vuelve a pasar el instalador' }

$reastream = 'C:\Program Files\VSTPlugins\ReaPlugs\reastream-standalone.dll'
if (Test-Path $reastream) { Anotar 'OK' 'ReaPlugs (ReaStream)' }
else { Anotar 'FALTA' 'ReaPlugs (ReaStream)' 'reaper.fm/reaplugs, version x64, en la carpeta C:\Program Files\VSTPlugins: FL y OBS lo buscan ahi' }

$cable = Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Where-Object FriendlyName -match '^CABLE Input'
if ($cable) { Anotar 'OK' 'VB-Cable' } else { Anotar 'FALTA' 'VB-Cable (audio para TikTok)' 'vb-audio.com/Cable: VBCABLE_Setup_x64.exe como administrador y reinicia' }

# La camara de Nexo como webcam usa el componente que registra el instalador de
# OBS (nexo-desktop/src/main/camara-virtual.js). El ayudante que la alimenta lo
# compila Nexo solo la primera vez, con el csc.exe que trae Windows.
$camVirtual = Test-Path 'Registry::HKEY_CLASSES_ROOT\CLSID\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'
$csc = Test-Path (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')
if ($camVirtual -and $csc) { Anotar 'OK' 'Camara virtual (fuente "Camara" en TikTok)' 'en las listas sale como "OBS Virtual Camera"' }
elseif (-not $camVirtual) { Anotar 'FALTA' 'Camara virtual de OBS sin registrar' 'reinstala OBS Studio: su instalador la registra' }
else { Anotar 'FALTA' 'Compilador de Windows (csc.exe)' 'activa .NET Framework 4.8 en "Activar o desactivar las caracteristicas de Windows"' }

$sideloadly = Primero @((Join-Path $env:LOCALAPPDATA 'Sideloadly\sideloadly.exe'), 'C:\Program Files\Sideloadly\sideloadly.exe', 'C:\Program Files (x86)\Sideloadly\sideloadly.exe')
if ($sideloadly) { Anotar 'OK' 'Sideloadly' } else { Anotar 'FALTA' 'Sideloadly (firma de la app del iPhone)' 'sideloadly.io' }

$tiktok = Primero @('C:\Program Files\TikTok LIVE Studio\TikTok LIVE Studio Launcher.exe')
if ($tiktok) { Anotar 'OK' 'TikTok LIVE Studio' } else { Anotar 'FALTA' 'TikTok LIVE Studio' 'tiktok.com/studio/download' }

# --------------------------------------------------- 2. Dependencias de Nexo --

Paso 'Dependencias de Nexo'
$electron = Join-Path $Raiz 'node_modules\electron\dist\electron.exe'
if (Test-Path $electron) { Anotar 'OK' 'Electron ya instalado' }
elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Anotar 'FALTA' 'npm' 'instala Node.js y vuelve a pasar el instalador' }
elseif (-not $SoloComprobar) {
  Push-Location $Raiz
  npm ci
  Pop-Location
  if (Test-Path $electron) { Anotar 'OK' 'Dependencias instaladas (npm ci)' } else { Anotar 'FALTA' 'npm ci fallo' 'mira el mensaje de arriba' }
} else { Anotar 'FALTA' 'Dependencias sin instalar' 'npm ci en la raiz' }

# ------------------------------------------------------ 3. config-pc.json ----

Paso 'Configuracion de este PC'
# Clave del registro donde FL guarda su driver: cambia con la version de FL.
$claveFL = Get-ChildItem 'HKCU:\Software\Image-Line' -ErrorAction SilentlyContinue |
  Where-Object { $_.PSChildName -match '^FL Studio' -and (Test-Path (Join-Path $_.PSPath 'Devices\Audio output')) } |
  Sort-Object PSChildName -Descending | Select-Object -First 1
$claveFLRuta = if ($claveFL) { "HKCU:\Software\Image-Line\$($claveFL.PSChildName)\Devices\Audio output" } else { $null }

$config = [ordered]@{
  interfaz = [ordered]@{ nombre = $Interfaz; asio = $driverAsio; entradaWindows = $Interfaz }
  fl = [ordered]@{
    exe = $flExe
    proyecto = Join-Path $env:USERPROFILE 'Documents\Image-Line\FL Studio\Projects\lives 1\lives 1.flp'
    claveRegistro = $claveFLRuta
  }
  reaper = [ordered]@{ exe = Primero @('C:\Program Files\REAPER (x64)\reaper.exe') }
  obs = [ordered]@{ exe = Primero @('C:\Program Files\obs-studio\bin\64bit\obs64.exe'); perfil = 'Nexo Horizontal' }
  chrome = Primero @('C:\Program Files\Google\Chrome\Application\chrome.exe')
  tiktok = $tiktok
}
$archivoCfg = Join-Path $Raiz 'config-pc.json'
if (-not $SoloComprobar) {
  # Sin BOM: tambien lo puede leer Node.
  [IO.File]::WriteAllText($archivoCfg, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  Anotar 'OK' 'config-pc.json escrito' "interfaz: $(if ($driverAsio) { $driverAsio } else { "$Interfaz (sin driver todavia)" })"
}
if (-not $claveFLRuta) { Anotar 'AVISO' 'FL aun no se ha abierto nunca' 'abrelo una vez y vuelve a pasar el instalador para fijar su driver' }

# ---------------------------------------------------------- 4. Kit privado --

Paso 'Kit privado (escenas, proyectos, notas)'
if (-not $Kit) {
  $Kit = Get-ChildItem ([Environment]::GetFolderPath('Desktop')), (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'OneDrive') `
    -Filter 'Nexo-kit-privado*.zip' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$carpetaKit = $null
if (-not $Kit -or -not (Test-Path $Kit)) {
  Anotar 'FALTA' 'Kit privado' 'en el PC viejo: herramientas\exportar-kit.ps1, y deja el zip en el Escritorio o en Descargas'
} elseif ((Get-Item $Kit).PSIsContainer) {
  $carpetaKit = $Kit
} else {
  $carpetaKit = Join-Path $env:TEMP ('nexo-kit-' + [IO.Path]::GetFileNameWithoutExtension($Kit))
  if (Test-Path $carpetaKit) { Remove-Item -LiteralPath $carpetaKit -Recurse -Force }
  Expand-Archive -LiteralPath $Kit -DestinationPath $carpetaKit
  Anotar 'OK' 'Kit encontrado' $Kit
}

if ($carpetaKit) {
  # --- OBS: perfiles y escenas, con OBS cerrado (los pisa al salir) --------
  $obs = Join-Path $env:APPDATA 'obs-studio\basic'
  $obsKit = Join-Path $carpetaKit 'obs'
  if (Get-Process obs64 -ErrorAction SilentlyContinue) {
    Anotar 'FALTA' 'Escenas de OBS sin copiar' 'cierra OBS y vuelve a pasar el instalador'
  } elseif (Test-Path $obsKit) {
    Get-ChildItem (Join-Path $obsKit 'profiles') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Copiar-Seguro $_.FullName (Join-Path $obs "profiles\$($_.Name)")
    }
    Get-ChildItem (Join-Path $obsKit 'scenes') -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
      Copiar-Seguro $_.FullName (Join-Path $obs "scenes\$($_.Name)")
    }
    Anotar 'OK' 'Perfiles y escenas de OBS' "Nexo Horizontal y Nexo Vertical$copia"
    Anotar 'AVISO' 'OBS: clave de emision de YouTube' 'Ajustes > Emision: pegala de nuevo (no viaja en el kit)'
    Anotar 'AVISO' 'OBS: pantalla que se captura' 'escena Estudio > Pantalla > Propiedades: elige el monitor donde va FL'

    # La fuente "FL Studio (ReaStream)" se apoya en una entrada de la interfaz
    # (le marca el ritmo al filtro). Su id es de Windows y distinto en cada PC.
    $idEntrada = $null
    $capturas = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
    foreach ($k in Get-ChildItem $capturas -ErrorAction SilentlyContinue) {
      if ((Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).DeviceState -ne 1) { continue }
      $props = Get-ItemProperty -LiteralPath (Join-Path $k.PSPath 'Properties') -ErrorAction SilentlyContinue
      $nombre = "$($props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2') $($props.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6')"
      if ($nombre -match [regex]::Escape($Interfaz)) { $idEntrada = "{0.0.1.00000000}.$($k.PSChildName)"; break }
    }
    if (-not $idEntrada) {
      Anotar 'FALTA' 'Fuente de ReaStream en OBS sin reapuntar' "conecta la interfaz ($Interfaz) y vuelve a pasar el instalador"
    } elseif (-not $SoloComprobar) {
      node (Join-Path $Raiz 'herramientas\audio-obs.js') --dispositivo $idEntrada
      if ($LASTEXITCODE -eq 0) { Anotar 'OK' 'Fuente de ReaStream reapuntada a la interfaz' $idEntrada }
      else { Anotar 'FALTA' 'No se pudo reapuntar la fuente de ReaStream' 'mira el mensaje de audio-obs.js' }
    }
  }

  # --- FL, Reaper e iPhone ----------------------------------------------
  $flKit = Join-Path $carpetaKit 'fl'
  if (Test-Path $flKit) {
    $proyectos = Join-Path $env:USERPROFILE 'Documents\Image-Line\FL Studio\Projects'
    Get-ChildItem $flKit -Directory | ForEach-Object { Copiar-Seguro $_.FullName (Join-Path $proyectos $_.Name) }
    Anotar 'OK' 'Proyectos de FL' ((((Get-ChildItem $flKit -Directory).Name) -join ', ') + $copia)
  }
  $rpp = Join-Path $carpetaKit 'reaper\Directo - cantar.RPP'
  if (Test-Path $rpp) {
    Copiar-Seguro $rpp (Join-Path $env:APPDATA 'REAPER\ProjectTemplates\Directo - cantar.RPP')
    Anotar 'OK' 'Plantilla de Reaper "Directo - cantar"' $copia.Trim()
    Anotar 'AVISO' 'Reaper: driver de la interfaz' "Options > Preferences > Audio > Device: ASIO, $(if ($driverAsio) { $driverAsio } else { 'el de la interfaz' }), 44100 Hz"
  }
  $ipa = Get-ChildItem (Join-Path $carpetaKit 'iphone') -Filter '*.ipa' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($ipa) {
    Copiar-Seguro $ipa.FullName (Join-Path $Raiz "dist\$($ipa.Name)")
    # La del kit es la ultima probada. En GitHub (pestana Actions) puede haber
    # una mas nueva con arreglos aun sin probar en el iPhone.
    Anotar 'AVISO' 'App del iPhone: firmarla desde este PC' "Sideloadly con tu Apple ID y dist\$($ipa.Name); luego doble clic en instalar-guardian.bat"
  }

  # --- Notas de Claude ----------------------------------------------------
  # Claude busca su memoria en una carpeta nombrada con la ruta del proyecto.
  $notasKit = Join-Path $carpetaKit 'claude\memoria'
  if (Test-Path $notasKit) {
    $slug = ($Raiz -replace '[:\\ ]', '-')
    $memoria = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"
    if (-not $SoloComprobar) {
      New-Item -ItemType Directory -Force $memoria | Out-Null
      Get-ChildItem $notasKit -Filter '*.md' | ForEach-Object { Copiar-Seguro $_.FullName (Join-Path $memoria $_.Name) }
    }
    Anotar 'OK' 'Notas de Claude sobre el montaje' "$memoria$copia"
  }
}

# --------------------------------------------------- 5. Driver de FL --------

Paso 'Driver de audio de FL'
if ($claveFLRuta -and $driverAsio) {
  $actual = (Get-ItemProperty $claveFLRuta -ErrorAction SilentlyContinue).'Device name'
  if ($actual -eq "1$driverAsio") { Anotar 'OK' 'FL ya usa el driver de la interfaz' }
  elseif (Get-Process FL64 -ErrorAction SilentlyContinue) { Anotar 'FALTA' 'FL abierto: no toco su driver' "F10 > Audio > Dispositivo > $driverAsio" }
  elseif (-not $SoloComprobar) { Set-ItemProperty $claveFLRuta -Name 'Device name' -Value "1$driverAsio"; Anotar 'OK' 'Driver de FL fijado' $driverAsio }
}
Anotar 'AVISO' 'FL: entrada del micro' 'Master > entrada "In 1" en MONO y "Monitorear la entrada externa: Activo"'

# ------------------------------------------------- 6. Accesos directos -----

Paso 'Accesos directos'
if (-not $SoloComprobar) {
  $sh = New-Object -ComObject WScript.Shell
  $escritorio = [Environment]::GetFolderPath('Desktop')
  $icono = Join-Path $Raiz 'nexo-desktop\recursos\icono.ico'
  $accesos = @(
    @{ Nombre = 'Nexo'; Destino = $electron; Args = '.'; Carpeta = (Join-Path $Raiz 'nexo-desktop') },
    @{ Nombre = 'Iniciar directo'; Destino = (Join-Path $Raiz 'INICIAR DIRECTO.bat'); Args = ''; Carpeta = $Raiz }
  )
  foreach ($a in $accesos) {
    $l = $sh.CreateShortcut((Join-Path $escritorio "$($a.Nombre).lnk"))
    $l.TargetPath = $a.Destino; $l.Arguments = $a.Args; $l.WorkingDirectory = $a.Carpeta
    if (Test-Path $icono) { $l.IconLocation = $icono }
    $l.Save()
  }
  Anotar 'OK' 'Accesos "Nexo" e "Iniciar directo" en el Escritorio'
}

# --------------------------------------------------------- 7. Resumen -------

Write-Host ''
Write-Host '== Falta por hacer' -ForegroundColor Cyan
if ($pendiente.Count -eq 0) { Write-Host '  Nada. Prueba con "Iniciar directo".' -ForegroundColor Green }
else { $i = 1; foreach ($p in $pendiente) { Write-Host ("  {0,2}. {1}" -f $i, $p); $i++ } }
Write-Host ''
Write-Host '  Siempre a mano, una vez:' -ForegroundColor Cyan
Write-Host '   - TikTok LIVE Studio: iniciar sesion y montar las secuencias (Producir, Componer, Karaoke).'
Write-Host '   - En el PC viejo, cuando este ya firme la app: herramientas\instalar-guardian.ps1 -Desinstalar'
Write-Host '     (con Apple ID gratuito, dos PCs firmando se invalidan la firma el uno al otro).'
Write-Host ''
