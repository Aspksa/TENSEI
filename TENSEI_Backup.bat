@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TENSEI Personal Data Backup
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\transfer.ps1" -Mode Backup -Archive "%~1"
if errorlevel 1 (
  echo.
  echo Operation failed. Original data was not intentionally overwritten.
)
echo.
pause
