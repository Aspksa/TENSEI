@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TENSEI Offline Portable Package
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offline-pack.ps1"
if errorlevel 1 echo Offline package creation failed. Start TENSEI.bat online once first.
echo.
pause
