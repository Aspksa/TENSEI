@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TENSEI - Portable Launcher
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
if errorlevel 1 (
  echo.
  echo TENSEI could not start. Read the error shown above.
  pause
)
