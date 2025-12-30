#!/usr/bin/env python3
from __future__ import annotations
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

import pystray
from PIL import Image, ImageDraw

def _get_root_dir() -> str:
  if getattr(sys, "frozen", False):
    return os.path.dirname(sys.executable)
  return os.path.dirname(os.path.abspath(__file__))

ROOT = _get_root_dir()
HOST = "127.0.0.1"
PORT = 48159
HEALTH_URL = f"http://{HOST}:{PORT}/health"
SHUTDOWN_URL = f"http://{HOST}:{PORT}/shutdown"
MODELS_DIR = os.path.join(ROOT, "models")
CACHE_DIR = os.path.join(ROOT, "cache")
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_PATH = os.path.join(ROOT, "host.log")
PID_PATH = os.path.join(ROOT, "tray.pid")


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


def _launch_host(log_file):
  script = os.path.join(ROOT, "host_server.py")
  if not os.path.exists(script):
    return None
  creationflags = 0x08000000 if os.name == "nt" else 0
  try:
    return subprocess.Popen(
      [_find_pythonw(), script],
      cwd=ROOT,
      stdin=subprocess.DEVNULL,
      stdout=log_file or subprocess.DEVNULL,
      stderr=log_file or subprocess.DEVNULL,
      creationflags=creationflags
    )
  except Exception:
    return None


def _ping_host() -> bool:
  try:
    with urllib.request.urlopen(HEALTH_URL, timeout=0.6) as resp:
      return resp.status == 200
  except Exception:
    return False


class HostController:
  def __init__(self):
    self.proc = None
    self.log_file = None

  def is_running(self) -> bool:
    return _ping_host()

  def start(self):
    if self.is_running():
      return
    try:
      self.log_file = open(LOG_PATH, "a", encoding="utf-8")
    except Exception:
      self.log_file = None
    self.proc = _launch_host(self.log_file)

  def stop(self):
    try:
      urllib.request.urlopen(SHUTDOWN_URL, timeout=1)
    except Exception:
      pass
    if self.proc:
      try:
        self.proc.wait(timeout=2)
      except Exception:
        try:
          self.proc.terminate()
        except Exception:
          pass
      self.proc = None
    if self.log_file:
      try:
        self.log_file.close()
      except Exception:
        pass
      self.log_file = None

  def clear_cache(self):
    if not os.path.isdir(CACHE_DIR):
      return
    wrapped = os.path.abspath(os.path.join(CACHE_DIR, "wrapped_models"))
    for root, dirs, files in os.walk(CACHE_DIR):
      if os.path.abspath(root) == wrapped:
        continue
      if "wrapped_models" in dirs:
        dirs.remove("wrapped_models")
      for fn in files:
        try:
          os.remove(os.path.join(root, fn))
        except Exception:
          pass


def _load_icon() -> Image.Image:
  candidates = [
    os.path.join(ROOT, "tray_icon.png"),
    os.path.join(ROOT, "..", "extension", "icons", "icon48.png")
  ]
  for path in candidates:
    if os.path.exists(path):
      try:
        return Image.open(path)
      except Exception:
        pass
  img = Image.new("RGB", (64, 64), (24, 20, 30))
  draw = ImageDraw.Draw(img)
  draw.ellipse((10, 10, 54, 54), fill=(255, 127, 200), outline=(250, 230, 240))
  return img


def _open_folder(path: str):
  try:
    if os.path.isdir(path):
      os.startfile(path)
  except Exception:
    pass

def _open_file(path: str):
  try:
    if os.path.exists(path):
      os.startfile(path)
  except Exception:
    pass

def _load_config_allow_dat2() -> bool:
  try:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
      cfg = json.load(f)
    return bool(cfg.get("allow_dat2", False))
  except Exception:
    return False

def _write_pid():
  try:
    with open(PID_PATH, "w", encoding="utf-8") as f:
      f.write(str(os.getpid()))
  except Exception:
    pass

def _remove_pid():
  try:
    if os.path.exists(PID_PATH):
      os.remove(PID_PATH)
  except Exception:
    pass


def _on_start(icon, item, ctl: HostController):
  ctl.start()


def _on_stop(icon, item, ctl: HostController):
  ctl.stop()


def _on_open_cache(icon, item):
  _open_folder(CACHE_DIR)


def _on_open_models(icon, item):
  _open_folder(MODELS_DIR)


def _on_open_settings(icon, item):
  _open_file(CONFIG_PATH)


def _on_open_log(icon, item):
  _open_file(LOG_PATH)


def _on_open_config(icon, item):
  _open_folder(ROOT)


def _on_clear_cache(icon, item, ctl: HostController):
  ctl.clear_cache()


def _on_download_models(icon, item, ctl: HostController):
  ctl.start()
  try:
    allow_dat2 = _load_config_allow_dat2()
    payload = json.dumps({"allow_dat2": allow_dat2}).encode("utf-8")
    req = urllib.request.Request(
      f"http://{HOST}:{PORT}/models/download",
      data=payload,
      headers={"Content-Type": "application/json"},
      method="POST"
    )
    urllib.request.urlopen(req, timeout=30)
  except Exception:
    pass


def _on_quit(icon, item, ctl: HostController):
  ctl.stop()
  _remove_pid()
  icon.stop()


def _status_loop(icon, ctl: HostController):
  while True:
    running = ctl.is_running()
    icon.title = f"Manga Upscaler Host ({'running' if running else 'stopped'})"
    time.sleep(2)


def main():
  _write_pid()
  ctl = HostController()
  ctl.start()

  menu = pystray.Menu(
    pystray.MenuItem("Start host", lambda icon, item: _on_start(icon, item, ctl), enabled=lambda item: not ctl.is_running()),
    pystray.MenuItem("Stop host", lambda icon, item: _on_stop(icon, item, ctl), enabled=lambda item: ctl.is_running()),
    pystray.Menu.SEPARATOR,
    pystray.MenuItem("Open cache folder", _on_open_cache),
    pystray.MenuItem("Open models folder", _on_open_models),
    pystray.MenuItem("Open settings (config.json)", _on_open_settings),
    pystray.MenuItem("Open host log", _on_open_log),
    pystray.MenuItem("Open host folder", _on_open_config),
    pystray.MenuItem("Clear cache", lambda icon, item: _on_clear_cache(icon, item, ctl)),
    pystray.MenuItem("Download models", lambda icon, item: _on_download_models(icon, item, ctl)),
    pystray.Menu.SEPARATOR,
    pystray.MenuItem("Quit", lambda icon, item: _on_quit(icon, item, ctl))
  )

  icon = pystray.Icon("MangaUpscalerHost", _load_icon(), "Manga Upscaler Host", menu)
  threading.Thread(target=_status_loop, args=(icon, ctl), daemon=True).start()
  icon.run()


if __name__ == "__main__":
  main()
