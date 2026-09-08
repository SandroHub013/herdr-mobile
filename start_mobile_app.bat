@echo off
title Herdr Mobile - Expo dev server
echo ========================================================
echo       Herdr Mobile - Expo dev server
echo ========================================================
echo.
echo  1. Make sure the bridge is running (start_bridge.bat)
echo  2. Open Expo Go on your Android or iOS phone
echo  3. Scan the QR code to start the app
echo.
echo ========================================================
echo.

cd /d "%~dp0\app"
bun x expo start

pause
