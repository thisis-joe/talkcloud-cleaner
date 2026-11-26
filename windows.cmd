@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || goto :missing
if not exist node_modules\playwright\package.json (
  call npm.cmd ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 goto :failed
)
node app.mjs
if errorlevel 1 goto :failed
exit /b 0
:missing
echo Install Node.js 22 or newer and run this file again.
:failed
pause
exit /b 1
