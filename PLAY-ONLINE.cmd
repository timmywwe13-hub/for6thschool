@echo off
rem ---------------------------------------------------------------------------
rem  ISLE ROYALE - put the lobby online for this session (no account, no git).
rem
rem  Double-click this file. It starts the lobby, opens a free Cloudflare tunnel
rem  to it, and prints the ONE link to send everybody:
rem
rem      https://<random-words>.trycloudflare.com/?room=isle
rem
rem  Everybody who opens that link is in the room - Chromebooks, phones, anything
rem  - because the lobby serves the game as well as relaying it. Nothing to
rem  install on their side, and no files to hand round.
rem
rem  Needs: Node.js once (https://nodejs.org/), and a tunnel tool - this offers to
rem  install cloudflared with winget if it is missing. Leave the window open while
rem  people are playing; Ctrl-C stops everything.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title ISLE ROYALE - lobby online
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\play-online.ps1"
if errorlevel 1 pause
