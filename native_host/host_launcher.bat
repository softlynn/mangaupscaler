@echo off
cd /d %~dp0
if exist "MangaUpscalerNativeHost.exe" (
  "MangaUpscalerNativeHost.exe"
  exit /b 0
)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" native_messaging_host.py
) else (
  python native_messaging_host.py
)
