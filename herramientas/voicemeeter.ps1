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
#   .\voicemeeter.ps1 -Montar                       -> deja el montaje de las dos interfaces
#
# -Montar se pasa en cada arranque del directo: VoiceMeeter solo guarda su
# configuracion al cerrarse bien, y tras un reinicio del PC amanecio en blanco
# (sin interfaces, a 48 000 Hz) con Reaper mandando silencio absoluto
# (06/10/2026). La segunda interfaz se busca por su identificador de hardware y
# no por el nombre, que cambia con el puerto USB ("2- M-Audio...", "3- M-Audio...").
param(
  [switch]$Listar,
  [string[]]$Leer = @(),
  [hashtable]$Poner = @{},
  [switch]$Montar,
  # Driver ASIO de la interfaz principal (trozo del nombre) y fabricante USB de
  # la segunda (08BB = el chip de la M-Track Solo).
  [string]$Principal = 'AIR 192',
  [string]$SegundaVid = '08BB',
  [int]$Buffer = 128
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

  if ($Montar) {
    # Los dispositivos tal y como los ve VoiceMeeter ahora mismo.
    function Dispositivos([string]$sentido) {
      $n = if ($sentido -eq 'Input') { [VM]::VBVMR_Input_GetDeviceNumber() } else { [VM]::VBVMR_Output_GetDeviceNumber() }
      for ($i = 0; $i -lt $n; $i++) {
        $t = 0; $nom = New-Object Text.StringBuilder 512; $id = New-Object Text.StringBuilder 512
        if ($sentido -eq 'Input') { [VM]::VBVMR_Input_GetDeviceDescA($i, [ref]$t, $nom, $id) | Out-Null }
        else { [VM]::VBVMR_Output_GetDeviceDescA($i, [ref]$t, $nom, $id) | Out-Null }
        [pscustomobject]@{ Clase = $clase[$t]; Nombre = "$nom"; Id = "$id" }
      }
    }
    $salidas = @(Dispositivos 'Output'); $entradas = @(Dispositivos 'Input')
    $asio = $salidas | Where-Object { $_.Clase -eq 'ASIO' -and $_.Nombre -match [regex]::Escape($Principal) } | Select-Object -First 1
    $micro = $entradas | Where-Object { $_.Clase -eq 'KS' -and $_.Id -match "VID_$SegundaVid" } | Select-Object -First 1
    $cascos = $salidas | Where-Object { $_.Clase -eq 'KS' -and $_.Id -match "VID_$SegundaVid" } | Select-Object -First 1
    if (-not $asio) { throw "VoiceMeeter no ve el driver ASIO de la interfaz principal ($Principal)" }
    if (-not $micro) { Write-Host "  AVISO: la segunda interfaz (VID_$SegundaVid) no esta enchufada: solo entra el micro de la principal" }

    # Si ya esta montado, no se toca: reiniciar el motor corta el audio un
    # instante, y esto se llama en cada arranque del directo.
    $ya = New-Object Text.StringBuilder 512; [VM]::VBVMR_GetParameterStringA('Bus[0].device.name', $ya) | Out-Null
    $ya1 = New-Object Text.StringBuilder 512; [VM]::VBVMR_GetParameterStringA('Strip[1].device.name', $ya1) | Out-Null
    $sr = 0.0; [VM]::VBVMR_GetParameterFloat('Bus[0].device.sr', [ref]$sr) | Out-Null
    $b1 = 0.0; [VM]::VBVMR_GetParameterFloat('Strip[1].B1', [ref]$b1) | Out-Null
    $a2 = 0.0; [VM]::VBVMR_GetParameterFloat('Strip[3].A2', [ref]$a2) | Out-Null
    if ("$ya" -eq $asio.Nombre -and $sr -eq 44100 -and $b1 -eq 1 -and $a2 -eq 1 -and ((-not $micro) -or "$ya1" -eq $micro.Nombre)) {
      Write-Host ("  ya estaba montado: {0} a {1} Hz" -f $ya, $sr)
      return
    }

    # En orden: primero el motor, luego la mezcla y al final los dispositivos.
    $pasos = @(
      @('Option.sr', 44100), @('Option.buffer.asio', $Buffer), @('Option.buffer.ks', $Buffer),
      # Cada micro a un lado del bus B1, que es lo que el DAW recibe por
      # "Voicemeeter Virtual ASIO": entrada 1 = principal, entrada 2 = segunda.
      @('Strip[0].Mono', 1), @('Strip[0].Pan_x', -0.5), @('Strip[0].Gain', 0), @('Strip[0].Mute', 0),
      @('Strip[0].A1', 0), @('Strip[0].A2', 0), @('Strip[0].A3', 0), @('Strip[0].B1', 1), @('Strip[0].B2', 0),
      @('Strip[1].Mono', 1), @('Strip[1].Pan_x', 0.5), @('Strip[1].Gain', 0), @('Strip[1].Mute', 0),
      @('Strip[1].A1', 0), @('Strip[1].A2', 0), @('Strip[1].A3', 0), @('Strip[1].B1', 1), @('Strip[1].B2', 0),
      @('Strip[2].A1', 0), @('Strip[2].B1', 0),
      # Lo que sale del DAW (tira virtual 3) va a los auriculares de las dos
      # interfaces, y NO a B1: volveria a entrarle al DAW.
      @('Strip[3].A1', 1), @('Strip[3].A2', 1), @('Strip[3].A3', 0), @('Strip[3].B1', 0), @('Strip[3].B2', 0), @('Strip[3].Gain', 0), @('Strip[3].Mute', 0),
      @('Strip[4].A1', 0), @('Strip[4].A2', 0), @('Strip[4].B1', 0), @('Strip[4].B2', 0),
      @('Bus[0].Gain', 0), @('Bus[0].Mute', 0), @('Bus[1].Gain', 0), @('Bus[1].Mute', 0), @('Bus[3].Gain', 0), @('Bus[3].Mute', 0),
      @('Bus[0].device.asio', $asio.Nombre),
      # La tira 0 no lleva dispositivo: coge las entradas 1 y 2 del ASIO principal.
      @('patch.asio[0]', 1), @('patch.asio[1]', 2)
    )
    if ($micro) { $pasos += , @('Strip[1].device.ks', $micro.Nombre) }
    if ($cascos) { $pasos += , @('Bus[1].device.ks', $cascos.Nombre) }
    $pasos += , @('Command.Restart', 1)
    foreach ($p in $pasos) {
      $c = if ($p[1] -is [string]) { [VM]::VBVMR_SetParameterStringA($p[0], $p[1]) } else { [VM]::VBVMR_SetParameterFloat($p[0], [float]$p[1]) }
      if ($c -ne 0) { Write-Host ("  ERROR {0} al poner {1}" -f $c, $p[0]) }
      Start-Sleep -Milliseconds 60
    }
    Start-Sleep -Seconds 4
    Esperar
    $s = New-Object Text.StringBuilder 512; [VM]::VBVMR_GetParameterStringA('Bus[0].device.name', $s) | Out-Null
    $f = 0.0; [VM]::VBVMR_GetParameterFloat('Bus[0].device.sr', [ref]$f) | Out-Null
    Write-Host ("  principal: {0} a {1} Hz | segunda: {2}" -f $s, $f, $(if ($micro) { 'micro y auriculares por KS' } else { 'no esta' }))
    if ("$s" -notmatch [regex]::Escape($Principal)) { throw 'VoiceMeeter no se quedo con la interfaz principal' }
  }

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
