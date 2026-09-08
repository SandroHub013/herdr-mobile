@echo off
title Herdr Mobile bridge
echo ========================================================
echo       Herdr Mobile bridge (port 43737)
echo ========================================================
echo.
echo  Listens on the Tailscale address by default.
echo  Add --lan to also serve the local network.
echo.

cd /d "%~dp0\bridge"
python bridge.py %*

pause
