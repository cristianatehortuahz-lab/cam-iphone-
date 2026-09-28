# Guardian de la firma de Nexo Cam.
#
# Con Apple ID gratuito el certificado dura 7 dias. Sideloadly trae un daemon
# que re-firma solo a las 96 h, y esa parte ya esta dada de alta (la tabla
# `installations` de Sideloadly tiene Nexo con one_off=0 y refresh_at_hours=96).
#
# El problema no era la renovacion, era que el daemon no estaba vivo cuando
# tocaba:
#   - el 19/09/2026 se colgo (AppHangB1 en el visor de eventos) y nadie lo
#     volvio a levantar;
#   - la entrada de la clave Run no deja rastro de haber arrancado nunca: el
#     unico log del daemon en todo el perfil estaba en la carpeta del proyecto,
#     o sea de las veces que se abrio a mano.
#
# Esto se ejecuta al iniciar sesion y cada media hora. Es idempotente: si el
# daemon ya corre, no hace nada. Solo lo arranca si falta.
#
# No firma nada por su cuenta ni toca credenciales: de eso se encarga Sideloadly
# con la sesion que ya tiene guardada.

[CmdletBinding()]
param(
  # Solo informa de la situacion y sale, sin arrancar nada.
  [switch]$SoloComprobar
)

$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Sideloadly'
$exe = Join-Path $dir 'sideloadlydaemon.exe'
$bitacora = Join-Path $dir 'guardian-nexo.log'

function Anotar($texto) {
  $linea = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $texto
  Write-Host $linea
  try { Add-Content -Path $bitacora -Value $linea -Encoding utf8 } catch { }
}

if (-not (Test-Path $exe)) {
  Anotar "ERROR: no encuentro $exe. Reinstala Sideloadly desde https://sideloadly.io"
  exit 1
}

$vivo = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like '*sideloadlydaemon*' })

if ($vivo.Count -gt 1) {
  # Varias instancias se pisan entre si al tocar installations.db. Dejamos la
  # mas antigua, que es la que tiene el estado bueno.
  $sobran = $vivo | Sort-Object StartTime | Select-Object -Skip 1
  foreach ($p in $sobran) {
    Anotar "sobraba una instancia (PID $($p.Id)); la cierro"
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Anotar "  no pude cerrarla: $($_.Exception.Message)" }
  }
  $vivo = @($vivo | Sort-Object StartTime | Select-Object -First 1)
}

if ($vivo.Count -eq 1) {
  $p = $vivo[0]
  # Responding=false es justo el estado previo a que Windows lo mate por cuelgue.
  if (-not $p.Responding) {
    Anotar "el daemon (PID $($p.Id)) esta colgado; lo reinicio"
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Start-Sleep -Seconds 2 } catch { }
  } else {
    if (-not $SoloComprobar) {
      $horas = [math]::Round(((Get-Date) - $p.StartTime).TotalHours, 1)
      Anotar "daemon vivo (PID $($p.Id), $horas h). Nada que hacer."
    }
    exit 0
  }
}

if ($SoloComprobar) {
  Anotar "el daemon NO esta corriendo."
  exit 2
}

# WorkingDirectory importa: el daemon escribe sideloadlydaemon.log en su
# directorio actual, y sin esto acaba dentro del repositorio del proyecto.
Anotar "arrancando el daemon..."
Start-Process -FilePath $exe -WorkingDirectory $dir -WindowStyle Hidden
Start-Sleep -Seconds 5

$ok = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like '*sideloadlydaemon*' })
if ($ok.Count -ge 1) {
  Anotar "arrancado (PID $($ok[0].Id))"
  exit 0
}

Anotar "ERROR: no consigo mantenerlo arrancado"
exit 1
