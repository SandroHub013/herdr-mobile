@echo off
title Herdr Mobile bridge (next)
echo ========================================================
echo       Herdr Mobile bridge - next (port 43738)
echo ========================================================
echo.
echo  The rewritten bridge, on its own port so it can run
echo  beside the one already serving your phone.
echo.
echo  It needs Node 22 or newer instead of Python, and it
echo  speaks the conversation API: a phone running 1.2.1 or
echo  older cannot use it, though it can still see and
echo  download an update from it.
echo.
echo  Add --lan to also serve the local network.
echo  Add --port 43737 once you are ready to replace the old one.
echo.

cd /d "%~dp0\bridge-ts"
if not exist "node_modules" (
  echo  Installing dependencies, once...
  call npm install
  echo.
)
node src/main.ts --port 43738 %*

pause
