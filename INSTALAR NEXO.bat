@echo off
title Nexo - Instalacion en este PC
echo.
echo   NEXO - Instalacion en este PC
echo   =============================
echo.
echo   Instala lo que necesitan Nexo y el montaje de directos, restaura el kit
echo   privado (Nexo-kit-privado-*.zip en el Escritorio o en Descargas) y crea
echo   los accesos directos. Pregunta antes de instalar programas y no borra
echo   nada: lo que ya existiera queda copiado con ".antes-nexo".
echo.
echo   Conecta antes la interfaz de audio y el iPhone.
echo   Mejor con Claude abierto en esta carpeta: lee CLAUDE.md y te ayuda con
echo   lo que quede pendiente.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0herramientas\instalar-nexo.ps1" %*
echo.
pause
