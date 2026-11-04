@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TENSEI Local Data Audit
cd /d "%~dp0"
set "NODE=%~dp0.runtime\node-win-x64\node.exe"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE=%~dp0.runtime\node-win-arm64\node.exe"
if not exist "%NODE%" (
  echo Portable Node.js not found. First launch TENSEI.bat once.
  echo This check never changes or deletes your data.
  pause
  exit /b 1
)
"%NODE%" "%~dp0scripts\audit.mjs"
echo.
echo This report contains counts only, not filenames or API keys.
pause
