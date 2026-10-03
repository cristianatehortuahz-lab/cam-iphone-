# Junta en un zip lo que el montaje de directos necesita y NO esta en el repo
# (que es publico): escenas y perfiles de OBS, proyectos de FL, la plantilla de
# Reaper, la app del iPhone sin firmar y las notas de Claude sobre este montaje.
# El zip se lleva al PC nuevo (USB, OneDrive, Drive) y lo instala
# herramientas\instalar-nexo.ps1.
#
# Se queda fuera a proposito, por ser secreto o de este PC:
#   - service.json de OBS: lleva la clave de emision de YouTube.
#   - la sesion de TikTok LIVE Studio y la de Sideloadly (Apple ID).
#   - legado\certs y clave.txt de Nexo: se regeneran solos en el PC nuevo.
#
#   .\exportar-kit.ps1                -> zip en el Escritorio
#   .\exportar-kit.ps1 -Destino D:\   -> zip en otra carpeta (un USB, por ejemplo)

[CmdletBinding()]
param([string]$Destino = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$Raiz = Split-Path -Parent $PSScriptRoot

$fecha = Get-Date -Format 'yyyyMMdd-HHmm'
$trabajo = Join-Path $env:TEMP "nexo-kit-$fecha"
$zip = Join-Path $Destino "Nexo-kit-privado-$fecha.zip"
New-Item -ItemType Directory -Force $trabajo | Out-Null

$lista = New-Object System.Collections.Generic.List[string]
function Anotar([string]$estado, [string]$que) {
  $color = if ($estado -eq 'OK') { 'Green' } else { 'Yellow' }
  Write-Host ("  [{0,-5}] {1}" -f $estado, $que) -ForegroundColor $color
  $lista.Add("[$estado] $que")
}
function Copiar([string]$origen, [string]$destinoRel) {
  $d = Join-Path $trabajo $destinoRel
  New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null
  Copy-Item -LiteralPath $origen -Destination $d -Force
}

Write-Host ''
Write-Host '  NEXO - exportar el kit privado' -ForegroundColor Cyan
Write-Host ''

# OBS guarda las escenas al cerrarse: con OBS abierto se exportaria una version vieja.
if (Get-Process obs64 -ErrorAction SilentlyContinue) {
  Write-Host '  OBS esta abierto: cierralo para exportar la ultima version de las escenas.' -ForegroundColor Yellow
  $r = Read-Host '  Exporto de todas formas? (S/N)'
  if ($r -notmatch '^[sS]') { exit 1 }
}

# --- OBS -----------------------------------------------------------------
$obs = Join-Path $env:APPDATA 'obs-studio\basic'
foreach ($perfil in 'Nexo Horizontal', 'Nexo Vertical') {
  $dir = Join-Path $obs "profiles\$perfil"
  if (-not (Test-Path $dir)) { Anotar 'FALTA' "perfil de OBS '$perfil'"; continue }
  Get-ChildItem $dir -File | Where-Object { $_.Name -notmatch '^service\.json' -and $_.Extension -ne '.bak' } |
    ForEach-Object { Copiar $_.FullName "obs\profiles\$perfil\$($_.Name)" }
  Anotar 'OK' "perfil de OBS '$perfil' (sin la clave de emision)"
}
foreach ($coleccion in 'Nexo Horizontal', 'Nexo Vertical') {
  $f = Join-Path $obs "scenes\$coleccion.json"
  if (Test-Path $f) { Copiar $f "obs\scenes\$coleccion.json"; Anotar 'OK' "escenas de OBS '$coleccion'" }
  else { Anotar 'FALTA' "escenas de OBS '$coleccion'" }
}

# --- FL Studio -----------------------------------------------------------
$proyectos = Join-Path $env:USERPROFILE 'Documents\Image-Line\FL Studio\Projects'
foreach ($p in 'lives 1', 'DirectoNexo') {
  $f = Join-Path $proyectos "$p\$p.flp"
  if (Test-Path $f) { Copiar $f "fl\$p\$p.flp"; Anotar 'OK' "proyecto de FL '$p'" }
  else { Anotar 'FALTA' "proyecto de FL '$p'" }
}

# --- Reaper --------------------------------------------------------------
$plantilla = Join-Path $env:APPDATA 'REAPER\ProjectTemplates\Directo - cantar.RPP'
if (Test-Path $plantilla) { Copiar $plantilla 'reaper\Directo - cantar.RPP'; Anotar 'OK' 'plantilla de Reaper "Directo - cantar"' }
else { Anotar 'FALTA' 'plantilla de Reaper "Directo - cantar"' }

# --- App del iPhone ------------------------------------------------------
# La mas reciente que haya en dist: es la que se firma con Sideloadly.
$ipa = Get-ChildItem (Join-Path $Raiz 'dist') -Filter '*.ipa' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($ipa) { Copiar $ipa.FullName "iphone\$($ipa.Name)"; Anotar 'OK' "app del iPhone sin firmar ($($ipa.Name), $($ipa.LastWriteTime.ToString('dd/MM/yyyy')))" }
else { Anotar 'FALTA' 'app del iPhone sin firmar (dist\*.ipa)' }

# --- Notas de Claude -----------------------------------------------------
# La carpeta de memoria se nombra con la ruta del proyecto (":", "\" y espacios
# pasan a "-"). En el PC nuevo, instalar-nexo.ps1 la calcula con su ruta.
$slug = ($Raiz -replace '[:\\ ]', '-')
$memoria = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"
$notas = Get-ChildItem $memoria -Filter '*.md' -ErrorAction SilentlyContinue
if ($notas) { $notas | ForEach-Object { Copiar $_.FullName "claude\memoria\$($_.Name)" }; Anotar 'OK' "notas de Claude ($($notas.Count) archivos)" }
else { Anotar 'FALTA' "notas de Claude ($memoria)" }

# --- Leeme y zip ---------------------------------------------------------
$leeme = @"
NEXO - kit privado del montaje de directos
Exportado el $(Get-Date -Format 'dd/MM/yyyy HH:mm') desde $env:COMPUTERNAME.

NO lo subas a GitHub ni lo compartas: son tus escenas, proyectos y notas.

Para instalarlo en el PC nuevo: clona el repositorio, deja este zip en el
Escritorio o en Descargas y haz doble clic en "INSTALAR NEXO.bat" (lo encuentra
solo). Mejor con Claude abierto en la carpeta del proyecto: lee CLAUDE.md.

Contenido:
$($lista -join "`r`n")

Fuera a proposito: clave de emision de OBS (service.json), sesiones de TikTok y
Sideloadly, certificados y clave de acceso de Nexo (se regeneran).
"@
[IO.File]::WriteAllText((Join-Path $trabajo 'LEEME.txt'), $leeme, (New-Object Text.UTF8Encoding $true))

if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $trabajo '*') -DestinationPath $zip
Remove-Item -LiteralPath $trabajo -Recurse -Force

Write-Host ''
Write-Host "  Kit listo: $zip" -ForegroundColor Green
Write-Host ("  {0:N1} MB. Llevalo al PC nuevo por USB, OneDrive o Drive; NO lo subas a GitHub." -f ((Get-Item $zip).Length / 1MB))
