@echo off
title Nexo - Preparar directo
rem Prepara el PC para un directo: cierra lo que sobra, abre Nexo, OBS, FL y
rem TikTok LIVE Studio en orden, los coloca y comprueba que todo funciona.
rem Detalles: herramientas\iniciar-directo.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0herramientas\iniciar-directo.ps1" %*
echo.
pause
