@echo off
title Herdr Mobile - Expo App
echo ========================================================
echo       Herdr Mobile - Expo Dev Server
echo ========================================================
echo.
echo  1. Assicurati che il bridge daemon sia avviato (start_bridge.bat)
echo  2. Apri Expo Go sul tuo telefono Android/iOS
echo  3. Inquadra il QR code per avviare l'app nativa!
echo.
echo ========================================================
echo.

cd /d "%~dp0\app"
bun x expo start

pause
