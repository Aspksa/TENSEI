@echo off
setlocal
cd /d "%~dp0"
set "OMP_NUM_THREADS=1"
set "OPENBLAS_NUM_THREADS=1"
set "MKL_NUM_THREADS=1"
set "NUMEXPR_NUM_THREADS=1"
set "TENSEI_RAPIDOCR_KEEP_WARM=0"
echo TENSEI RapidOCR CPU (optional, one request at a time).
echo Main TENSEI will continue to work if this window is closed.
if not exist ".rapidocr-venv\Scripts\python.exe" (
  echo Creating isolated Python 3.11 environment...
  py -3.11 -m venv ".rapidocr-venv"
  if errorlevel 1 goto :failed
  echo Installing optional CPU OCR dependencies...
  ".rapidocr-venv\Scripts\python.exe" -m pip install -r "scripts\rapidocr-requirements.txt"
  if errorlevel 1 goto :failed
)
".rapidocr-venv\Scripts\python.exe" scripts\rapidocr_service.py
if errorlevel 1 goto :failed
exit /b 0
:failed
echo RapidOCR did not start. Check Python 3.11 and the optional dependencies.
pause
exit /b 1
