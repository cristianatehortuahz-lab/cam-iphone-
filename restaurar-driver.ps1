# Restaura el driver USB de Apple despues de usar Sideloadly.
#
# Sideloadly instala su propio driver libusb-win32 sobre el iPhone para poder
# firmar. Funciona para el, pero suplanta al driver de Apple y deja ciego al
# Apple Mobile Device Service: usbmux pasa a ver cero dispositivos y Nexo deja
# de funcionar por cable. Esto quita ese paquete y deja que Windows vuelva al
# driver bueno (usbccgp).

$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "  Hace falta ejecutarlo como administrador." -ForegroundColor Yellow
  Write-Host "  Clic derecho > Ejecutar con PowerShell como administrador."
  exit 1
}

$nodo = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -match 'VID_05AC' -and $_.Class -eq 'libusb-win32 devices' } |
  Select-Object -First 1

if (-not $nodo) {
  Write-Host "  El driver de Apple ya esta bien: no hay nada que restaurar." -ForegroundColor Green
  exit 0
}

$inf = (Get-PnpDeviceProperty -InstanceId $nodo.InstanceId `
  -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction SilentlyContinue).Data
Write-Host "  Quitando el driver libusb ($inf)..."
pnputil /delete-driver $inf /uninstall | Out-Null
pnputil /scan-devices | Out-Null
Start-Sleep -Seconds 5

$ok = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -match 'VID_05AC' -and $_.Class -eq 'USBDevice' }
if ($ok) {
  Write-Host "  Listo: el iPhone vuelve a usar el driver de Apple." -ForegroundColor Green
} else {
  Write-Host "  Quitado, pero Windows aun no lo reasigna. Desenchufa y vuelve a enchufar el iPhone." -ForegroundColor Yellow
}
