@echo off
cd /d %~dp0
if exist ".venv\Scripts\python.exe" (
  .venv\Scripts\python host_server.py
) else (
  python host_server.py
)
pause
