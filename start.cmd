@echo off
setlocal
cd /d "%~dp0"
title Reflector Activity

if "%PORT%"=="" set PORT=8787

rem --- Pick a Node.js: the bundled one in runtime\ if present, otherwise the one on PATH ---
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto have_node

where node >nul 2>nul
if errorlevel 1 goto no_node
set "NODE_EXE=node"
node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)"
if errorlevel 1 goto old_node

:have_node
rem Live data goes outside the app folder (sync tools corrupt a database they copy mid-write)
if not defined DATA_DIR set "DATA_DIR=%LOCALAPPDATA%\ReflectorActivity"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

rem --- First run: ask for the user's own callsign (used only to identify the YSF listener) ---
if not exist config.json powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-config.ps1"

if not defined NO_BROWSER start "" http://localhost:%PORT%

echo Starting Reflector Activity on http://localhost:%PORT%  (Ctrl+C to stop)
echo Server messages and errors appear below and are also saved to %DATA_DIR%\server.log
echo.

rem Show output live and keep a copy; PowerShell's Tee-Object does both. Errors (stderr) are included.
powershell -NoProfile -Command "& { & $env:NODE_EXE server.mjs 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath (Join-Path $env:DATA_DIR 'server.log') }; exit $LASTEXITCODE"
set EXITCODE=%errorlevel%

echo.
echo ==============================================================
echo Server stopped (exit code %EXITCODE%). Scroll up for the error.
echo The same output is saved in %DATA_DIR%\server.log
echo ==============================================================
pause
exit /b %EXITCODE%

:no_node
echo Node.js was not found. This package normally includes it in the "runtime" folder.
echo Either re-extract the full Windows zip, or install Node.js 24 or newer from https://nodejs.org
pause
exit /b 1

:old_node
echo Your Node.js is too old. Reflector Activity needs Node.js 24 or newer.
echo Install a current version from https://nodejs.org and run this again.
pause
exit /b 1
