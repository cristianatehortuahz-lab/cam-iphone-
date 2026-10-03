@echo off
rem Abre la ventana con la camara de Nexo que captura TikTok LIVE Studio
rem ("electron.exe Nexo - Camara 1:1"). Nexo Desktop tiene que estar abierto.
rem No la minimices durante el directo: puede quedar tapada, pero minimizada
rem TikTok deja de verla.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0herramientas\ventana-camara\main.js" 1:1
