#!/usr/bin/env python3
from __future__ import annotations
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

def _get_root_dir() -> str:
  if getattr(sys, "frozen", False):
    return os.path.dirname(sys.executable)
  return os.path.dirname(os.path.abspath(__file__))

ROOT = _get_root_dir()
HEALTH_URL = "http://127.0.0.1:48159/health"
SHUTDOWN_URL = "http://127.0.0.1:48159/shutdown"
TRAY_EXE = "MangaUpscalerHost.exe"
PID_PATH = os.path.join(ROOT, "tray.pid")
_tray_proc = None


def _read_message():
  raw_len = sys.stdin.buffer.read(4)
  if not raw_len:
    return None
  msg_len = struct.unpack("<I", raw_len)[0]
  data = sys.stdin.buffer.read(msg_len)
  if not data:
    return None
  return json.loads(data.decode("utf-8"))


def _send_message(obj: dict):
  data = json.dumps(obj).encode("utf-8")
  sys.stdout.buffer.write(struct.pack("<I", len(data)))
  sys.stdout.buffer.write(data)
  sys.stdout.buffer.flush()


def _ping_host() -> bool:
  try:
    with urllib.request.urlopen(HEALTH_URL, timeout=0.5) as resp:
      return resp.status == 200
  except Exception:
    return False


def _find_pythonw() -> str:
  candidates = [
    os.path.join(ROOT, ".venv", "Scripts", "pythonw.exe"),
    os.path.join(ROOT, ".venv", "Scripts", "python.exe")
  ]
  if not getattr(sys, "frozen", False):
    candidates.append(sys.executable)
  candidates.extend(["pythonw", "python"])
  for path in candidates:
    if path in ("pythonw", "python"):
      return path
    if path and os.path.exists(path):
      return path
  return "python"


def _find_tray_exe() -> str | None:
  candidates = [
    os.path.join(ROOT, TRAY_EXE),
    os.path.join(ROOT, "MangaUpscalerTray.exe")
  ]
  for path in candidates:
    if os.path.exists(path):
      return path
  return None


def _launch_tray() -> bool:
  exe = _find_tray_exe()
  if exe:
    cmd = [exe]
  else:
    script = os.path.join(ROOT, "tray_app.py")
    if not os.path.exists(script):
      return False
    cmd = [_find_pythonw(), script]

  creationflags = 0
  if os.name == "nt":
    creationflags = 0x08000000  # CREATE_NO_WINDOW
  try:
    global _tray_proc
    _tray_proc = subprocess.Popen(
      cmd,
      cwd=ROOT,
      stdin=subprocess.DEVNULL,
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
      creationflags=creationflags
    )
    return True
  except Exception:
    return False

def _stop_tray() -> bool:
  stopped = False
  try:
    if _tray_proc and _tray_proc.poll() is None:
      _tray_proc.terminate()
      stopped = True
  except Exception:
    pass
  try:
    if os.path.exists(PID_PATH):
      with open(PID_PATH, "r", encoding="utf-8") as f:
        pid = int(f.read().strip() or "0")
      if pid > 0:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stopped = True
  except Exception:
    pass
  if os.name == "nt":
    try:
      subprocess.run(["taskkill", "/IM", TRAY_EXE, "/T", "/F"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
      stopped = True
    except Exception:
      pass
  return stopped


def _start_host() -> dict:
  if _ping_host():
    return {"ok": True, "running": True, "started": False}
  if not _launch_tray():
    return {"ok": False, "error": "Failed to launch tray host"}
  for _ in range(12):
    if _ping_host():
      return {"ok": True, "running": True, "started": True}
    time.sleep(0.4)
  return {"ok": False, "error": "Host did not start"}


def _stop_host() -> dict:
  try:
    req = urllib.request.Request(SHUTDOWN_URL, data=b"", method="POST")
    urllib.request.urlopen(req, timeout=1)
  except Exception:
    pass
  time.sleep(0.2)
  return {"ok": True, "running": _ping_host()}


def _handle(msg: dict) -> dict:
  cmd = (msg or {}).get("cmd") or (msg or {}).get("type") or ""
  cmd = str(cmd).lower()
  if cmd == "start":
    return _start_host()
  if cmd == "stop":
    return _stop_host()
  if cmd == "tray_start":
    return {"ok": _launch_tray()}
  if cmd == "tray_stop":
    return {"ok": _stop_tray()}
  if cmd == "status":
    return {"ok": True, "running": _ping_host()}
  return {"ok": False, "error": "Unknown command"}


def main():
  while True:
    msg = _read_message()
    if msg is None:
      break
    resp = _handle(msg)
    _send_message(resp)


if __name__ == "__main__":
  main()
