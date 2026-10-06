# Maneja VoiceMeeter Banana desde fuera, con su API remota (VoicemeeterRemote64.dll):
# lo arranca, lista los dispositivos que ve y lee o cambia sus parametros.
#
# VoiceMeeter junta las dos interfaces de audio (AIR 192|4 + M-Track Solo)
# corrigiendo la deriva entre sus relojes y se presenta al DAW como un solo driver
# ASIO. ASIO4ALL, que hace lo mismo sin corregirla, metia ruido en la voz
# (04-05/10/2026).
#
#   .\voicemeeter.ps1 -Listar                       -> dispositivos de entrada y salida
#   .\voicemeeter.ps1 -Leer 'Bus[0].device.name'    -> un parametro (varios, separados por coma)
#   .\voicemeeter.ps1 -Poner @{ 'Strip[0].Mono'=1; 'Bus[0].device.asio'='M-Audio AIR 192 4 ASIO' }
param(
  [switch]$Listar,
  [string[]]$Leer = @(),
  [hashtable]$Poner = @{}
)
$ErrorActionPreference = 'Stop'
$dll = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll'
if (-not (Test-Path $dll)) { throw 'VoiceMeeter no esta instalado' }

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class VM {
  const string D = @"$dll";
  [DllImport(D)] public static extern int VBVMR_Login();
  [DllImport(D)] public static extern int VBVMR_Logout();
  [DllImport(D)] public static extern int VBVMR_RunVoicemeeter(int tipo);
  [DllImport(D)] public static extern int VBVMR_GetVoicemeeterType(out int tipo);
  [DllImport(D)] public static extern int VBVMR_IsParametersDirty();
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_SetParameterFloat(string nombre, float valor);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_SetParameterStringA(string nombre, string valor);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_GetParameterFloat(string nombre, out float valor);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_GetParameterStringA(string nombre, StringBuilder valor);
  [DllImport(D)] public static extern int VBVMR_Input_GetDeviceNumber();
  [DllImport(D)] public static extern int VBVMR_Output_GetDeviceNumber();
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_Input_GetDeviceDescA(int i, out int tipo, StringBuilder nombre, StringBuilder id);
  [DllImport(D, CharSet = CharSet.Ansi)] public static extern int VBVMR_Output_GetDeviceDescA(int i, out int tipo, StringBuilder nombre, StringBuilder id);
}
"@

# Login devuelve 1 si VoiceMeeter no esta abierto: se arranca (2 = Banana).
$r = [VM]::VBVMR_Login()
if ($r -eq 1) { [VM]::VBVMR_RunVoicemeeter(2) | Out-Null; Start-Sleep -Seconds 4 }
elseif ($r -lt 0) { throw "no pude conectar con VoiceMeeter (codigo $r)" }
try {
  # La API va con retraso: hay que vaciar el "sucio" antes de leer.
  function Esperar { 1..10 | ForEach-Object { [VM]::VBVMR_IsParametersDirty() | Out-Null; Start-Sleep -Milliseconds 60 } }
  Esperar
  $clase = @{ 1 = 'MME'; 3 = 'WDM'; 4 = 'KS'; 5 = 'ASIO' }

  foreach ($k in $Poner.Keys) {
    $v = $Poner[$k]
    $c = if ($v -is [string]) { [VM]::VBVMR_SetParameterStringA($k, $v) } else { [VM]::VBVMR_SetParameterFloat($k, [float]$v) }
    Write-Host ("  {0,-34} = {1}{2}" -f $k, $v, $(if ($c -ne 0) { "   (ERROR $c)" } else { '' }))
    Start-Sleep -Milliseconds 120
  }
  if ($Poner.Count) { Start-Sleep -Milliseconds 800; Esperar }

  if ($Listar) {
    foreach ($sentido in 'Input', 'Output') {
      Write-Host $(if ($sentido -eq 'Input') { 'ENTRADAS' } else { 'SALIDAS' })
      $n = if ($sentido -eq 'Input') { [VM]::VBVMR_Input_GetDeviceNumber() } else { [VM]::VBVMR_Output_GetDeviceNumber() }
      for ($i = 0; $i -lt $n; $i++) {
        $t = 0; $nom = New-Object Text.StringBuilder 512; $id = New-Object Text.StringBuilder 512
        if ($sentido -eq 'Input') { [VM]::VBVMR_Input_GetDeviceDescA($i, [ref]$t, $nom, $id) | Out-Null }
        else { [VM]::VBVMR_Output_GetDeviceDescA($i, [ref]$t, $nom, $id) | Out-Null }
        # En KS varios dispositivos comparten nombre ("Line 1/2"): el identificador
        # de hardware (VID_0763 = AIR, VID_08BB = M-Track Solo) dice cual es cual.
        $vid = if ("$id" -match 'VID_[0-9A-Fa-f]{4}') { "   <$($Matches[0].ToUpper())>" } else { '' }
        Write-Host ("  [{0,-4}] {1}{2}" -f $clase[$t], $nom, $vid)
      }
    }
  }

  foreach ($k in $Leer) {
    $s = New-Object Text.StringBuilder 512
    if ($k -match 'device\.name|\.Label|\.device\.(asio|wdm|ks|mme)$' -and [VM]::VBVMR_GetParameterStringA($k, $s) -eq 0) { Write-Host ("  {0,-34} : {1}" -f $k, $s) }
    else { $f = 0.0; $c = [VM]::VBVMR_GetParameterFloat($k, [ref]$f); Write-Host ("  {0,-34} : {1}" -f $k, $(if ($c -eq 0) { $f } else { "(ERROR $c)" })) }
  }
} finally {
  [VM]::VBVMR_Logout() | Out-Null
}
