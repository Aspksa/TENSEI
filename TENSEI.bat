@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title TENSEI
if not exist ".runtime" mkdir ".runtime"
set "NODE=%~dp0.runtime\node\node.exe"
if not exist "%NODE%" (
 echo Downloading portable Node.js to this drive...
 powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v='v22.16.0'; $u='https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-x64.zip'; $z='.runtime\node.zip'; Invoke-WebRequest $u -OutFile $z; Expand-Archive -LiteralPath $z -DestinationPath '.runtime' -Force; Move-Item -LiteralPath ('.runtime\node-'+$v+'-win-x64') -Destination '.runtime\node'; Remove-Item $z"
 if errorlevel 1 (echo Download failed. Check internet. & pause & exit /b 1)
)
if not exist "node_modules\exceljs" (
 echo Installing dependencies...
 "%NODE%" ".runtime\node\node_modules\npm\bin\npm-cli.js" install --no-audit --no-fund
 if errorlevel 1 (echo Install error. & pause & exit /b 1)
)
echo Open http://127.0.0.1:57474 in your browser.
start "" "http://127.0.0.1:57474"
"%NODE%" server.mjs
pause
