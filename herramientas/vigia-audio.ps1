# Vigila el motor de VoiceMeeter durante el directo y lo levanta si se queda
# mudo. iniciar-directo.ps1 lo deja corriendo, sin ventana.
#
# El 10 y el 16/10/2026 el motor se paro solo varias veces: la interfaz
# principal seguia asignada pero su driver dejaba de dar audio (frecuencia 0, o
# todos los niveles a cero exacto) y el directo se quedaba en silencio hasta que
# alguien lo notaba. Coincidio con moviles entrando y saliendo por un
# concentrador USB; la causa no esta confirmada. Un micro enchufado nunca da cero
# exacto (siempre hay algo de ruido), asi que cero exacto en todas las entradas
# durante unos segundos es motor parado. Se reinicia (Command.Restart): corta el
# audio un instante, pero no hace falta reabrir el DAW (medido el 16/10/2026).
#
#   .\vigia-audio.ps1                 -> vigila hasta que se cierre VoiceMeeter
#   .\vigia-audio.ps1 -Segundos 60    -> solo ese tiempo (para probarlo)
#
# Bitacora: %TEMP%\nexo-vigia-audio.log
param(
  [int]$Segundos = 0,
  [int]$MudoMax = 4   # segundos seguidos en cero antes de reiniciar
)
$ErrorActionPreference = 'Stop'
$dll = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll'
if (-not (Test-Path $dll)) { throw 'VoiceMeeter no esta instalado' }
$bitacora = Join-Path $env:TEMP 'nexo-vigia-audio.log'
function Anotar([string]$texto) { Add-Content -Path $bitacora -Value ('{0}  {1}' -f (Get-Date -Format 'dd/MM HH:mm:ss'), $texto) }

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class VigiaVM {
  const string D = @"$dll";
  [DllImport(D)] public static extern int VBVMR_Login();
  [DllImport(D)] public static extern int VBVMR_Logout();
  [DllImport(D)] public static extern int VBVMR_IsParametersDirty();
  [DllImport(D)] public static extern int VBVMR_GetLevel(int tipo, int canal, out float valor);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_GetParameterFloat(string nombre, out float valor);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_SetParameterFloat(string nombre, float valor);
}
"@

# Solo uno a la vez: si ya hay otro vigia, este no hace nada.
$unico = New-Object Threading.Mutex($false, 'Local\NexoVigiaAudio')
if (-not $unico.WaitOne(0)) { return }
try {
  if ([VigiaVM]::VBVMR_Login() -lt 0) { Anotar 'no pude conectar con VoiceMeeter'; return }
  Anotar 'vigia en marcha'
  $fin = if ($Segundos -gt 0) { (Get-Date).AddSeconds($Segundos) } else { [datetime]::MaxValue }
  $mudo = 0; $reinicios = 0; $sinVM = 0; $latido = Get-Date; $motivo = 'tiempo cumplido'
  # El 16/10/2026 el vigia se cerro solo a los 17 s sin dejar dicho por que, y
  # el motor se paro despues sin nadie que lo levantara. Ahora solo termina si
  # VoiceMeeter lleva 30 s cerrado, y apunta el motivo.
  while ((Get-Date) -lt $fin) {
    Start-Sleep -Seconds 1
    if ([Diagnostics.Process]::GetProcessesByName('voicemeeterpro').Length -eq 0) {
      if (++$sinVM -ge 30) { $motivo = 'VoiceMeeter cerrado'; break }
      continue
    }
    $sinVM = 0
    if (((Get-Date) - $latido).TotalMinutes -ge 10) { Anotar 'sigue vigilando'; $latido = Get-Date }
    [VigiaVM]::VBVMR_IsParametersDirty() | Out-Null
    $sr = 0.0; [VigiaVM]::VBVMR_GetParameterFloat('Bus[0].device.sr', [ref]$sr) | Out-Null
    # Entradas de las tiras 0 y 1 (los dos micros) y 3 (lo que vuelve del DAW).
    $max = 0.0
    foreach ($c in 0, 1, 2, 3, 6, 7) { $v = 0.0; [VigiaVM]::VBVMR_GetLevel(0, $c, [ref]$v) | Out-Null; if ($v -gt $max) { $max = $v } }
    if ($sr -le 0 -or $max -eq 0) { $mudo++ } else {
      if ($mudo -ge $MudoMax) { Anotar 'motor vivo otra vez' }
      $mudo = 0
    }
    if ($mudo -eq $MudoMax) {
      $reinicios++
      Anotar ("motor mudo {0} s (frecuencia {1} Hz): reinicio numero {2}" -f $mudo, $sr, $reinicios)
      [VigiaVM]::VBVMR_SetParameterFloat('Command.Restart', 1) | Out-Null
      Start-Sleep -Seconds 5
    } elseif ($mudo -gt $MudoMax -and ($mudo - $MudoMax) % 20 -eq 0) {
      # Si no revive, se insiste cada 20 s, pero sin martillear.
      $reinicios++
      Anotar ("sigue mudo: reinicio numero {0}" -f $reinicios)
      [VigiaVM]::VBVMR_SetParameterFloat('Command.Restart', 1) | Out-Null
      Start-Sleep -Seconds 5
    }
  }
  Anotar ("vigia termina: {0} ({1} reinicios)" -f $motivo, $reinicios)
} catch {
  Anotar ("vigia cae por un error: {0}" -f $_.Exception.Message)
} finally {
  [VigiaVM]::VBVMR_Logout() | Out-Null
  $unico.ReleaseMutex()
}
