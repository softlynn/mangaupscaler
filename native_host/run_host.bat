@echo off
cd /d %~dp0

if /I "%1"=="--console" goto CONSOLE

if exist ".venv\Scripts\pythonw.exe" (
  ".venv\Scripts\pythonw.exe" tray_app.py
) else if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tray_app.py
) else (
  pythonw tray_app.py
)
exit /b 0

:CONSOLE
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" host_server.py
) else (
  python host_server.py
)
pause
