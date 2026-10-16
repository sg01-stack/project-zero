@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS version from https://nodejs.org/
  echo Then double-click Start EchoSphere.cmd again.
  pause
  exit /b 1
)
node scripts\serve.mjs --open
if errorlevel 1 echo EchoSphere stopped because of the error shown above.
pause
