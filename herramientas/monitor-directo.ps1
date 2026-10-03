# Vigila un directo o una grabacion sin tocar nada: cada minuto imprime una
# linea con recursos, fluidez, audio e iPhone, y una linea ALERTA en cuanto
# algo se tuerce. Solo lee: contadores de Windows, el registro de Nexo, su
# /api/nexo y unos segundos del audio de FL (herramientas/comprobar-audio.js).
#
#   .\monitor-directo.ps1 [-Intervalo 60] [-Minutos 0]   (0 = sin fin)

[CmdletBinding()]
param([int]$Intervalo = 60, [int]$Minutos = 0)

$ErrorActionPreference = 'SilentlyContinue'
$Raiz = Split-Path -Parent $PSScriptRoot
$LogNexo = Join-Path $env:TEMP 'nexo-out.log'
$Videos = Join-Path $env:USERPROFILE 'Videos'
$n = [Environment]::ProcessorCount

function Alerta([string]$t) { Write-Output ("{0} ALERTA {1}" -f (Get-Date -Format 'HH:mm'), $t) }

function Gpu {
  $s = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
  $tres = ($s | Where-Object InstanceName -match 'engtype_3d$' | Measure-Object CookedValue -Sum).Sum
  $codec = ($s | Where-Object InstanceName -match 'engtype_video codec' | Measure-Object CookedValue -Sum).Sum
  [pscustomobject]@{ D3 = [math]::Min(100, [math]::Round($tres)); Codec = [math]::Min(100, [math]::Round($codec)) }
}

# Lineas "[video] obs: llegan X pintados Y hueco max Z ms" de los ultimos
# $seg segundos. El registro de Nexo va en hora UTC.
function Video([int]$seg) {
  $desde = (Get-Date).ToUniversalTime().AddSeconds(-$seg).TimeOfDay
  $r = foreach ($l in (Get-Content $LogNexo -Tail 200)) {
    if ($l -match '^(\d\d:\d\d:\d\d)\.\d+ \[video\] obs: llegan (\d+) pintados (\d+) hueco max (\d+) ms') {
      $t = [TimeSpan]::Parse($Matches[1])
      if ($t -ge $desde) { [pscustomobject]@{ Llegan = [int]$Matches[2]; Pintados = [int]$Matches[3]; Hueco = [int]$Matches[4] } }
    }
  }
  $r
}

$archivoAnt = $null; $tamAnt = 0
$cpuAnt = @{}; Get-Process | ForEach-Object { $cpuAnt[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }
$inicio = Get-Date

while ($true) {
  $muestras = 1..[math]::Max(3, [int]($Intervalo / 10)) | ForEach-Object {
    (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
    Start-Sleep -Seconds ([math]::Max(1, [int]($Intervalo / [math]::Max(3, [int]($Intervalo / 10))) - 1))
  }
  $cpu = [math]::Round(($muestras | Measure-Object -Average).Average)
  $cpuMax = ($muestras | Measure-Object -Maximum).Maximum

  # Quien gasta: CPU de cada programa en el intervalo.
  $ahora = @{}; $uso = @{}
  foreach ($p in Get-Process) {
    $ms = $p.TotalProcessorTime.TotalMilliseconds; $ahora[$p.Id] = $ms
    if ($cpuAnt.ContainsKey($p.Id)) {
      $d = ($ms - $cpuAnt[$p.Id]) / ($Intervalo * 10) / $n
      if ($d -gt 0) { $uso[$p.ProcessName] = [double]$uso[$p.ProcessName] + $d }
    }
  }
  $cpuAnt = $ahora
  $top = ($uso.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 4 |
    ForEach-Object { '{0} {1:N0}%' -f ($_.Key -replace 'TikTok LIVE Studio', 'TikTok' -replace 'MediaSDK_Server', 'TikTokSDK'), $_.Value }) -join ', '

  $g = Gpu
  $ram = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)

  # Fluidez del video hacia OBS y la ventana de TikTok.
  $v = @(Video $Intervalo)
  if ($v.Count) {
    $lleg = ($v | Measure-Object Llegan -Sum).Sum; $pint = ($v | Measure-Object Pintados -Sum).Sum
    $hueco = ($v | Measure-Object Hueco -Maximum).Maximum
    $pct = if ($lleg) { [math]::Round(100 * $pint / $lleg) } else { 0 }
    $txtVideo = "video $pct% pintado, hueco max $hueco ms"
    if ($pct -lt 90) { Alerta "el video se esta perdiendo: solo $pct % de fotogramas pintados" }
    if ($hueco -gt 500) { Alerta "tiron de video de $hueco ms" }
  } else { $txtVideo = 'video: sin datos'; Alerta 'no llega video a OBS/TikTok (iPhone o Nexo)' }

  # iPhone
  try { $nx = Invoke-RestMethod 'http://localhost:8080/api/nexo' -TimeoutSec 3 } catch { $nx = $null }
  if ($nx -and $nx.iphone.conectado -and $nx.iphone.transmitiendo) { $txtCam = "iPhone $($nx.iphone.resolucionReal)@$($nx.iphone.fps)" }
  elseif ($nx) { $txtCam = 'iPhone DESCONECTADO'; Alerta 'el iPhone no esta emitiendo: abre Nexo Cam' }
  else { $txtCam = 'Nexo NO RESPONDE'; Alerta 'Nexo Desktop no responde' }

  # Audio de FL
  $a = node (Join-Path $Raiz 'herramientas\comprobar-audio.js') 2 | ConvertFrom-Json
  if ($a -and -not $a.error) {
    $nivel = [math]::Max([double]$a.nivelL, [double]$a.nivelR)
    $txtAudio = "audio $([math]::Round($nivel)) dB"
    if ($a.segundosSilencio -ge 2) { Alerta 'FL manda silencio absoluto (driver o monitoreo de In 1)' }
    elseif ($nivel -lt -80) { Alerta 'no llega el micro a la M-Audio (encendida? cable? ganancia?)' }
    elseif ($a.desequilibrioDb -ge 3) { Alerta "audio descompensado $($a.desequilibrioDb) dB (In 1 en mono)" }
    if ($a.muestrasPorSegundo -lt 42000) { Alerta "el audio llega a trompicones ($($a.muestrasPorSegundo) muestras/s, normal ~44100)" }
  } else { $txtAudio = 'audio: sin datos'; Alerta 'no llega audio de FL por ReaStream' }

  # Grabacion de OBS: que siga creciendo.
  $arch = Get-ChildItem $Videos -Filter '*.mkv' | Sort-Object LastWriteTime | Select-Object -Last 1
  $txtGrab = ''
  if ($arch -and $arch.LastWriteTime -gt (Get-Date).AddMinutes(-3)) {
    $mb = [math]::Round($arch.Length / 1MB)
    $ritmo = if ($archivoAnt -eq $arch.FullName) { [math]::Round(($arch.Length - $tamAnt) / 1MB / ($Intervalo / 60)) } else { $null }
    $txtGrab = if ($ritmo -ne $null) { " | grabando $mb MB (+$ritmo MB/min)" } else { " | grabando $mb MB" }
    if ($ritmo -eq 0) { Alerta 'la grabacion de OBS no crece' }
    $archivoAnt = $arch.FullName; $tamAnt = $arch.Length
  }

  if ($cpu -ge 90) { Alerta "CPU al $cpu % de media: riesgo de tirones y cortes" }

  Write-Output ("{0} CPU {1}% (max {2}) | GPU 3D {3}% cod {4}% | RAM libre {5} GB | {6} | {7} | {8}{9} | top: {10}" -f
    (Get-Date -Format 'HH:mm'), $cpu, $cpuMax, $g.D3, $g.Codec, $ram, $txtVideo, $txtAudio, $txtCam, $txtGrab, $top)

  if ($Minutos -gt 0 -and ((Get-Date) - $inicio).TotalMinutes -ge $Minutos) { break }
}
