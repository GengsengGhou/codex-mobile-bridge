@echo off
cd /d "%~dp0"
node scripts\start.mjs
if errorlevel 1 (
  echo.
  echo Startup failed. Check that Node.js 22 or newer is installed, then check configuration and logs.
  pause
)
