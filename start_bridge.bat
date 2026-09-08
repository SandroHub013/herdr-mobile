@echo off
title Herdr Mobile Bridge
echo ========================================================
echo       Herdr Mobile Bridge Daemon (Port 43737)
echo ========================================================
echo.

cd /d "%~dp0\bridge"
python bridge.py

pause
