@echo off
title Camara iPhone
cd /d "%~dp0"

if not exist "node_modules" (
  echo Instalando dependencias por primera vez...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias. Revisa que Node.js este instalado.
    pause
    exit /b 1
  )
)

rem Abre el visor cuando el servidor ya este escuchando.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:8080"

node server.js
pause
