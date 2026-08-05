@echo off
title Nexo - Reinstalar en el iPhone
echo.
echo   NEXO - Reinstalar Nexo Cam en el iPhone
echo   =======================================
echo.
echo   Con Apple ID gratuito, la app caduca cada 7 dias. Esto abre
echo   Sideloadly para volver a firmarla e instalarla por el cable.
echo.
echo   1. Conecta el iPhone por el cable USB-C y desbloquealo.
echo   2. Arrastra el .ipa a Sideloadly, pon tu Apple ID y pulsa Start.
echo.

rem Intenta abrir Sideloadly desde las rutas habituales.
set "SL="
if exist "%LOCALAPPDATA%\Programs\Sideloadly\Sideloadly.exe" set "SL=%LOCALAPPDATA%\Programs\Sideloadly\Sideloadly.exe"
if exist "%ProgramFiles%\Sideloadly\Sideloadly.exe" set "SL=%ProgramFiles%\Sideloadly\Sideloadly.exe"

if defined SL (
  start "" "%SL%"
  echo   Sideloadly abierto.
) else (
  echo   No encuentro Sideloadly. Instalalo desde https://sideloadly.io
  start "" "https://sideloadly.io"
)

echo.
echo   Guia completa: INSTALAR-IPHONE.md
echo.
pause
