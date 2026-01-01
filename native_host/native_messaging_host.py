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


def _launch_host_direct() -> bool:
  script = os.path.join(ROOT, "host_server.py")
  if not os.path.exists(script):
    return False
  creationflags = 0
  if os.name == "nt":
    creationflags = 0x08000000  # CREATE_NO_WINDOW
  try:
    subprocess.Popen(
      [_find_pythonw(), script],
      cwd=ROOT,
      stdin=subprocess.DEVNULL,
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
      creationflags=creationflags
    )
    return True
  except Exception:
    return False


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

def _run_tray_command(args: list[str], timeout_sec: float = 180.0) -> dict:
  exe = _find_tray_exe()
  if exe:
    cmd = [exe, *args]
  else:
    script = os.path.join(ROOT, "tray_app.py")
    if not os.path.exists(script):
      return {"ok": False, "error": "tray_app.py not found"}
    cmd = [_find_pythonw(), script, *args]

  creationflags = 0
  if os.name == "nt":
    creationflags = 0x08000000  # CREATE_NO_WINDOW
  try:
    p = subprocess.run(
      cmd,
      cwd=ROOT,
      stdin=subprocess.DEVNULL,
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      timeout=timeout_sec,
      creationflags=creationflags
    )
    out = (p.stdout or b"").decode("utf-8", "ignore").strip()
    if p.returncode == 0 and out:
      try:
        return json.loads(out)
      except Exception:
        return {"ok": True, "raw": out}
    if p.returncode == 0:
      return {"ok": True}
    err = (p.stderr or b"").decode("utf-8", "ignore").strip()
    return {"ok": False, "error": err or f"tray exit code {p.returncode}"}
  except subprocess.TimeoutExpired:
    return {"ok": False, "error": "Update timed out"}
  except Exception as e:
    return {"ok": False, "error": str(e)}

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

  # Best effort: start (or wake) the tray app. If it's already running, it may exit immediately due
  # to a single-instance mutex. We still want the host to come up.
  _launch_tray()

  # Give the tray a moment to start the HTTP server if it's a fresh launch.
  for _ in range(6):
    if _ping_host():
      return {"ok": True, "running": True, "started": True}
    time.sleep(0.35)

  # If the tray is already running and the host was previously shut down, launching the tray again
  # won't restart the server. Start the host directly as a fallback.
  if not _launch_host_direct():
    return {"ok": False, "error": "Failed to launch tray host and host_server.py"}
  for _ in range(10):
    if _ping_host():
      return {"ok": True, "running": True, "started": True}
    time.sleep(0.35)
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
  if cmd == "update_all":
    ext_id = str((msg or {}).get("extensionId") or "")
    # Runs the tray in headless updater mode and returns a JSON result.
    return _run_tray_command(["--update-all", "--extension-id", ext_id], timeout_sec=240.0)
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
