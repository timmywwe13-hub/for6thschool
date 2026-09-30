@echo off
rem ---------------------------------------------------------------------------
rem  ISLE ROYALE - host a lobby on this machine.
rem
rem  Double-click this file. It starts the lobby server (which also serves the
rem  game) and opens it in this machine's browser. The window that then stays
rem  open prints the address to send to the others, like
rem
rem      on your LAN   http://192.168.1.24:8787/?room=isle
rem
rem  Everybody on the same wifi opens that address in a browser - or you press
rem  COPY INVITE LINK in the game's FRIENDS panel and send that instead, which
rem  also works from anywhere with a tunnel or a host (see DEPLOY-ONLINE.md).
rem
rem  Only THIS machine needs Node.js, once: https://nodejs.org/
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title ISLE ROYALE - lobby

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this machine.
  echo.
  echo   Install it once from https://nodejs.org/ ^(the LTS button^), then
  echo   double-click this file again.
  echo.
  echo   Everybody else does NOT need it - they only need the address this
  echo   window prints, opened in a browser.
  echo.
  pause
  exit /b 1
)

rem open this machine's own browser once the server has had a moment to listen
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787/'"

echo.
echo   Starting the lobby - the address to share is printed below.
echo.
node lobby-server.js
echo.
echo   The lobby stopped. Double-click this file to start it again.
pause
