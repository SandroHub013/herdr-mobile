@echo off
title Herdr Mobile bridge (next)
echo ========================================================
echo       Herdr Mobile bridge - next
echo ========================================================
echo.
echo  The rewritten bridge, on the usual port 43737, so the
echo  phone reaches it at the address it already knows.
echo.
echo  It needs Node 22 or newer instead of Python, and it
echo  speaks the conversation API: a phone running 1.2.1 or
echo  older cannot use it, though it can still see and
echo  download an update from it.
echo.
echo  Close the old Python bridge first: they cannot both
echo  hold the same port.
echo.
echo  Add --lan to also serve the local network.
echo  Add --port 43738 to run it beside the old one instead.
echo.

cd /d "%~dp0\bridge-ts"
if not exist "node_modules" (
  echo  Installing dependencies, once...
  call npm install
  echo.
)
node src/main.ts %*

pause
