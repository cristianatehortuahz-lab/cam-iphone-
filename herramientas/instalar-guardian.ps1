# Registra (o quita) la tarea programada que mantiene vivo el daemon de
# Sideloadly, para que Nexo Cam se re-firme sola y no caduque a los 7 dias.
#
# Por que hace falta: la entrada "Sideloadly Daemon" de
# HKCU\Software\Microsoft\Windows\CurrentVersion\Run no arranca el daemon. Se
# comprobo el 20/09/2026: la maquina reinicio a las 14:35 y a las 18:20 el
# daemon seguia sin existir, sin ningun evento de cuelgue de por medio. Sin
# daemon no hay renovacion a las 96 h, y la app caduca al septimo dia.
#
# No hace falta ser administrador: la tarea corre como el usuario actual y con
# privilegios normales.
#
#   .\instalar-guardian.ps1              -> registra la tarea
#   .\instalar-guardian.ps1 -Desinstalar -> la elimina
#   .\instalar-guardian.ps1 -Estado      -> solo informa

[CmdletBinding()]
param(
  [switch]$Desinstalar,
  [switch]$Estado
)

$ErrorActionPreference = 'Stop'

$nombre = 'Nexo - Guardian de firma'
$script = Join-Path $PSScriptRoot 'guardian-firma.ps1'

function Mostrar-Estado {
  $t = Get-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue
  if ($t) {
    $info = Get-ScheduledTaskInfo -TaskName $nombre -ErrorAction SilentlyContinue
    Write-Host "  tarea      : registrada ($($t.State))" -ForegroundColor Green
    if ($info) {
      Write-Host "  ultima vez : $($info.LastRunTime)  (resultado $($info.LastTaskResult))"
      Write-Host "  proxima    : $($info.NextRunTime)"
    }
  } else {
    Write-Host "  tarea      : NO registrada" -ForegroundColor Yellow
  }

  $d = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -like '*sideloadlydaemon*' })
  if ($d) {
    Write-Host "  daemon     : vivo (PID $($d[0].Id), desde $($d[0].StartTime))" -ForegroundColor Green
  } else {
    Write-Host "  daemon     : parado" -ForegroundColor Yellow
  }
}

if ($Estado) { Mostrar-Estado; exit 0 }

if ($Desinstalar) {
  try {
    Unregister-ScheduledTask -TaskName $nombre -Confirm:$false -ErrorAction Stop
    Write-Host "  Tarea eliminada." -ForegroundColor Green
  } catch {
    Write-Host "  No habia ninguna tarea que eliminar." -ForegroundColor Yellow
  }
  exit 0
}

if (-not (Test-Path $script)) {
  Write-Host "  ERROR: no encuentro $script" -ForegroundColor Red
  exit 1
}

# Si ya existe, la rehacemos: asi el script es seguro de repetir.
try { Unregister-ScheduledTask -TaskName $nombre -Confirm:$false -ErrorAction Stop } catch { }

$accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $script)

# Al iniciar sesion cubre el reinicio, que es como se perdio el daemon el 20/09.
# La repeticion cada 30 min cubre el cuelgue, que es como se perdio el 19/09.
$alIniciar = New-ScheduledTaskTrigger -AtLogOn -User ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME)
$cadaRato = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 30)

$ajustes = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $nombre `
  -Action $accion -Trigger $alIniciar, $cadaRato -Settings $ajustes `
  -Description 'Mantiene vivo el daemon de Sideloadly para que Nexo Cam se re-firme sola cada 96 h y no caduque a los 7 dias.' `
  -RunLevel Limited | Out-Null

Write-Host "  Tarea registrada." -ForegroundColor Green
Write-Host ""
Mostrar-Estado
Write-Host ""
Write-Host "  Para quitarla:  .\instalar-guardian.ps1 -Desinstalar"
