@echo off
title Nexo - Guardian de la firma del iPhone
echo.
echo   NEXO - Guardian de la firma del iPhone
echo   ======================================
echo.
echo   La app del iPhone esta firmada con un Apple ID gratuito, y eso caduca
echo   a los 7 dias. Sideloadly trae un ayudante que la vuelve a firmar solo
echo   cada 4 dias, pero ese ayudante NO arranca con Windows: por eso la app
echo   caducaba una y otra vez.
echo.
echo   Esto crea una tarea de Windows que lo mantiene encendido: al iniciar
echo   sesion, y cada 30 minutos por si se cae. No necesita administrador.
echo.
echo   Para quitarla despues:  herramientas\instalar-guardian.ps1 -Desinstalar
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0herramientas\instalar-guardian.ps1"
echo.
pause
