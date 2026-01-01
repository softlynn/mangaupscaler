#!/usr/bin/env python3
from __future__ import annotations
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
import ctypes
from datetime import datetime
import argparse
import tempfile
import zipfile

import pystray
from PIL import Image, ImageDraw

def _set_dpi_awareness():
  if os.name != "nt":
    return
  try:
    # Per-monitor V2 when available (crisper menus on scaled displays).
    try:
      ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
      ctypes.windll.user32.SetProcessDPIAware()
  except Exception:
    pass

_set_dpi_awareness()

_tray_mutex = None

def _ensure_single_instance_or_exit():
  # Prevent multiple tray icons (can happen if the extension/installer starts it twice).
  if os.name != "nt":
    return
  try:
    name = "Global\\MangaUpscalerHostTray"
    h = ctypes.windll.kernel32.CreateMutexW(None, True, name)
    # ERROR_ALREADY_EXISTS = 183
    if ctypes.windll.kernel32.GetLastError() == 183:
      raise SystemExit(0)
    global _tray_mutex
    _tray_mutex = h
  except SystemExit:
    raise
  except Exception:
    # If mutex fails, fall back to PID-file best effort.
    try:
      if os.path.exists(PID_PATH):
        raise SystemExit(0)
    except SystemExit:
      raise
    except Exception:
      pass

def _get_root_dir() -> str:
  if getattr(sys, "frozen", False):
    return os.path.dirname(sys.executable)
  return os.path.dirname(os.path.abspath(__file__))

ROOT = _get_root_dir()
HOST = "127.0.0.1"
PORT = 48159
HEALTH_URL = f"http://{HOST}:{PORT}/health"
STATUS_URL = f"http://{HOST}:{PORT}/status"
SHUTDOWN_URL = f"http://{HOST}:{PORT}/shutdown"
MODELS_DIR = os.path.join(ROOT, "models")
CACHE_DIR = os.path.join(ROOT, "cache")
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_PATH = os.path.join(ROOT, "host.log")
PID_PATH = os.path.join(ROOT, "tray.pid")
UPDATE_API_URL = "https://api.github.com/repos/softlynn/mangaupscaler/releases/tags/alpha"
INSTALLER_ASSET_NAME = "MangaUpscalerHostSetup.exe"
INSTALLER_FALLBACK_URL = f"https://github.com/softlynn/mangaupscaler/releases/download/alpha/{INSTALLER_ASSET_NAME}"
EXTENSION_ASSET_NAME = "MangaUpscalerExtension.zip"
EXTENSION_FALLBACK_URL = f"https://github.com/softlynn/mangaupscaler/releases/download/alpha/{EXTENSION_ASSET_NAME}"


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

def _fetch_status() -> dict | None:
  try:
    with urllib.request.urlopen(STATUS_URL, timeout=0.8) as resp:
      if resp.status != 200:
        return None
      return json.loads(resp.read().decode("utf-8", "ignore") or "{}")
  except Exception:
    return None


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
      req = urllib.request.Request(SHUTDOWN_URL, data=b"", method="POST")
      urllib.request.urlopen(req, timeout=1)
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

def _make_busy_icon(base: Image.Image) -> Image.Image:
  try:
    img = base.convert("RGBA").copy()
  except Exception:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
  w, h = img.size
  r = max(5, min(w, h) // 7)
  pad = max(2, r // 2)
  cx = w - pad - r
  cy = h - pad - r
  draw = ImageDraw.Draw(img)
  draw.ellipse((cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2), fill=(0, 0, 0, 120))
  draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(46, 204, 113, 255), outline=(255, 255, 255, 220))
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

def _load_config() -> dict:
  try:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
      return json.load(f) or {}
  except Exception:
    return {}

def _save_config(cfg: dict) -> bool:
  try:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
  except Exception:
    pass
  try:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
      json.dump(cfg or {}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    return True
  except Exception:
    return False

def _parse_iso(s: str) -> datetime | None:
  try:
    s = (s or "").strip()
    if not s:
      return None
    if s.endswith("Z"):
      s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)
  except Exception:
    return None

def _fetch_latest_installer_info() -> tuple[str, str] | None:
  try:
    req = urllib.request.Request(
      UPDATE_API_URL,
      headers={
        "User-Agent": "MangaUpscalerHost",
        "Accept": "application/vnd.github+json"
      }
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
      if resp.status != 200:
        return None
      data = json.loads(resp.read().decode("utf-8", "ignore") or "{}")
    assets = data.get("assets") or []
    for a in assets:
      if str(a.get("name") or "") == INSTALLER_ASSET_NAME:
        return (str(a.get("updated_at") or ""), str(a.get("browser_download_url") or ""))
    # Fallback: if asset not found, use release updated_at + direct download URL.
    return (str(data.get("published_at") or data.get("created_at") or data.get("updated_at") or ""), INSTALLER_FALLBACK_URL)
  except Exception:
    return None

def _fetch_latest_extension_info() -> tuple[str, str] | None:
  try:
    req = urllib.request.Request(
      UPDATE_API_URL,
      headers={
        "User-Agent": "MangaUpscalerHost",
        "Accept": "application/vnd.github+json"
      }
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
      if resp.status != 200:
        return None
      data = json.loads(resp.read().decode("utf-8", "ignore") or "{}")
    assets = data.get("assets") or []
    for a in assets:
      if str(a.get("name") or "") == EXTENSION_ASSET_NAME:
        return (str(a.get("updated_at") or ""), str(a.get("browser_download_url") or ""))
    return (str(data.get("published_at") or data.get("created_at") or data.get("updated_at") or ""), EXTENSION_FALLBACK_URL)
  except Exception:
    return None

def _open_url(url: str):
  try:
    if url:
      os.startfile(url)
  except Exception:
    pass

def _download_to_temp(url: str) -> str | None:
  try:
    dest = os.path.join(tempfile.gettempdir(), f"{INSTALLER_ASSET_NAME}")
    req = urllib.request.Request(url, headers={"User-Agent": "MangaUpscalerHost"})
    with urllib.request.urlopen(req, timeout=20) as resp:
      if resp.status != 200:
        return None
      with open(dest, "wb") as f:
        while True:
          chunk = resp.read(1024 * 256)
          if not chunk:
            break
          f.write(chunk)
    return dest
  except Exception:
    return None

def _download_url_to_temp(url: str, filename: str) -> str | None:
  try:
    dest = os.path.join(tempfile.gettempdir(), filename)
    req = urllib.request.Request(url, headers={"User-Agent": "MangaUpscalerHost"})
    with urllib.request.urlopen(req, timeout=20) as resp:
      if resp.status != 200:
        return None
      with open(dest, "wb") as f:
        while True:
          chunk = resp.read(1024 * 256)
          if not chunk:
            break
          f.write(chunk)
    return dest
  except Exception:
    return None

def _run_installer_silent(path: str) -> bool:
  try:
    if not path or not os.path.exists(path):
      return False
    args = [path, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]
    subprocess.Popen(args, cwd=os.path.dirname(path))
    return True
  except Exception:
    return False

def _find_extension_path_windows(extension_id: str) -> str | None:
  try:
    ext_id = (extension_id or "").strip()
    if not ext_id:
      return None
    roots = [
      os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data"),
      os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Edge", "User Data"),
      os.path.join(os.environ.get("LOCALAPPDATA", ""), "BraveSoftware", "Brave-Browser", "User Data"),
      os.path.join(os.environ.get("LOCALAPPDATA", ""), "Chromium", "User Data"),
    ]
    pref_names = ["Secure Preferences", "Preferences"]
    for root in [r for r in roots if r and os.path.isdir(r)]:
      for prof in os.listdir(root):
        if not (prof == "Default" or prof.startswith("Profile ")):
          continue
        prof_dir = os.path.join(root, prof)
        for pn in pref_names:
          p = os.path.join(prof_dir, pn)
          if not os.path.exists(p):
            continue
          try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
              data = json.load(f) or {}
            settings = (((data.get("extensions") or {}).get("settings")) or {})
            entry = settings.get(ext_id) or {}
            path = str((entry.get("path") or "")).strip()
            if path and os.path.isdir(path) and os.path.exists(os.path.join(path, "manifest.json")):
              return path
          except Exception:
            continue
  except Exception:
    return None
  return None

def _apply_extension_update(zip_path: str, extension_id: str) -> tuple[bool, str]:
  if os.name != "nt":
    return (False, "unsupported_os")
  dest = _find_extension_path_windows(extension_id)
  if not dest:
    return (False, "extension_path_not_found")
  if not zip_path or not os.path.exists(zip_path):
    return (False, "missing_zip")

  try:
    tmp_dir = tempfile.mkdtemp(prefix="mu_ext_")
    with zipfile.ZipFile(zip_path, "r") as z:
      z.extractall(tmp_dir)
    for root, _dirs, files in os.walk(tmp_dir):
      rel = os.path.relpath(root, tmp_dir)
      out_dir = dest if rel == "." else os.path.join(dest, rel)
      os.makedirs(out_dir, exist_ok=True)
      for fn in files:
        src = os.path.join(root, fn)
        dst = os.path.join(out_dir, fn)
        try:
          tmp = dst + ".tmp"
          with open(src, "rb") as fsrc, open(tmp, "wb") as fdst:
            fdst.write(fsrc.read())
          os.replace(tmp, dst)
        except Exception:
          try:
            import shutil
            shutil.copy2(src, dst)
          except Exception:
            pass
    return (True, dest)
  except Exception:
    return (False, "extract_copy_failed")

def _check_update_available(cfg: dict) -> tuple[bool, str, str]:
  info = _fetch_latest_installer_info()
  if not info:
    return (False, "", "")
  remote_updated_at, url = info
  local_seen = str((cfg or {}).get("last_seen_installer_updated_at") or "")
  rt = _parse_iso(remote_updated_at)
  lt = _parse_iso(local_seen)
  if rt and (not lt or rt > lt):
    return (True, remote_updated_at, url)
  return (False, remote_updated_at, url)

def _toggle_auto_update(cfg: dict) -> bool:
  cur = bool((cfg or {}).get("auto_update_host", True))
  cfg["auto_update_host"] = (not cur)
  return _save_config(cfg)

def _run_update_flow(cfg: dict, ctl: HostController, icon: pystray.Icon | None, url: str, remote_updated_at: str):
  cfg["last_seen_installer_updated_at"] = remote_updated_at or cfg.get("last_seen_installer_updated_at", "")
  _save_config(cfg)

  # Stop host before launching installer so files can be replaced.
  try:
    ctl.stop()
  except Exception:
    pass

  path = _download_to_temp(url) if url else None
  if path:
    try:
      silent = bool(cfg.get("auto_update_host_silent", True))
      if silent:
        _run_installer_silent(path)
      else:
        subprocess.Popen([path], cwd=os.path.dirname(path))
    except Exception:
      _open_url(url)
  else:
    _open_url(url or "https://github.com/softlynn/mangaupscaler/releases/tag/alpha")

  # Exit tray to avoid locking files during update.
  try:
    _remove_pid()
  except Exception:
    pass
  try:
    if icon:
      icon.stop()
  except Exception:
    pass

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


def _status_loop(icon, ctl: HostController, idle_icon: Image.Image, busy_icon: Image.Image):
  last_busy = None
  while True:
    st = _fetch_status()
    running = bool(st and st.get("ok"))
    busy = bool(st and st.get("busy")) if running else False

    if running and busy:
      icon.title = "Manga Upscaler Host (enhancing)"
    elif running:
      icon.title = "Manga Upscaler Host (running)"
    else:
      icon.title = "Manga Upscaler Host (stopped)"

    if last_busy is None or busy != last_busy:
      try:
        icon.icon = busy_icon if busy else idle_icon
      except Exception:
        pass
      last_busy = busy

    time.sleep(0.7 if running else 1.4)


def _update_loop(icon: pystray.Icon, ctl: HostController):
  # Periodically check for updates and launch the latest installer if enabled.
  while True:
    try:
      cfg = _load_config()
      if bool(cfg.get("auto_update_host", True)):
        ok, remote_updated_at, url = _check_update_available(cfg)
        if ok:
          _run_update_flow(cfg, ctl, icon, url, remote_updated_at)
          return
    except Exception:
      pass
    time.sleep(6 * 60 * 60)  # 6h


def _on_check_updates(icon, item, ctl: HostController):
  cfg = _load_config()
  ok, remote_updated_at, url = _check_update_available(cfg)
  if ok:
    _run_update_flow(cfg, ctl, icon, url, remote_updated_at)
  else:
    _open_url("https://github.com/softlynn/mangaupscaler/releases/tag/alpha")


def _on_toggle_auto_update(icon, item):
  cfg = _load_config()
  _toggle_auto_update(cfg)

def run_update_all(extension_id: str) -> dict:
  cfg = _load_config()
  out: dict = {"ok": True, "host": {"checked": True}, "extension": {"checked": True}}

  # Host update (launch installer in background if newer)
  ok_h, remote_updated_at_h, url_h = _check_update_available(cfg)
  out["host"].update({"available": bool(ok_h), "updated_at": remote_updated_at_h, "url": url_h})
  if ok_h:
    cfg["last_seen_installer_updated_at"] = remote_updated_at_h or cfg.get("last_seen_installer_updated_at", "")
    _save_config(cfg)
    try:
      HostController().stop()
    except Exception:
      pass
    path = _download_to_temp(url_h) if url_h else None
    if path:
      out["host"]["launched"] = bool(_run_installer_silent(path))
    else:
      out["host"]["launched"] = False

  # Extension update (download zip and overwrite unpacked folder)
  info_e = _fetch_latest_extension_info()
  if not info_e:
    out["extension"].update({"available": False, "error": "no_release_info"})
    return out

  remote_updated_at_e, url_e = info_e
  local_seen = str(cfg.get("last_seen_extension_updated_at") or "")
  rt = _parse_iso(remote_updated_at_e)
  lt = _parse_iso(local_seen)
  ok_e = bool(rt and (not lt or rt > lt))
  out["extension"].update({"available": ok_e, "updated_at": remote_updated_at_e, "url": url_e})
  if ok_e:
    zip_path = _download_url_to_temp(url_e, EXTENSION_ASSET_NAME) if url_e else None
    ok_apply, info_apply = _apply_extension_update(zip_path or "", extension_id)
    out["extension"].update({"applied": bool(ok_apply), "path": info_apply if ok_apply else "", "error": "" if ok_apply else info_apply})
    if ok_apply:
      cfg["last_seen_extension_updated_at"] = remote_updated_at_e or cfg.get("last_seen_extension_updated_at", "")
      _save_config(cfg)

  return out


def main():
  # Headless updater mode (used by the extension's "Check for updates").
  try:
    if "--update-all" in sys.argv:
      ap = argparse.ArgumentParser(add_help=True)
      ap.add_argument("--update-all", action="store_true")
      ap.add_argument("--extension-id", default="")
      args = ap.parse_args()
      res = run_update_all(args.extension_id or "")
      print(json.dumps(res, ensure_ascii=False))
      return 0
  except Exception:
    # Fall through to normal tray mode.
    pass

  _ensure_single_instance_or_exit()
  _write_pid()
  ctl = HostController()
  ctl.start()

  menu = pystray.Menu(
    pystray.MenuItem("Start host", lambda icon, item: _on_start(icon, item, ctl), enabled=lambda item: not ctl.is_running()),
    pystray.MenuItem("Stop host", lambda icon, item: _on_stop(icon, item, ctl), enabled=lambda item: ctl.is_running()),
    pystray.Menu.SEPARATOR,
    pystray.MenuItem("Check for host updates", lambda icon, item: _on_check_updates(icon, item, ctl)),
    pystray.MenuItem("Auto-update host", _on_toggle_auto_update, checked=lambda item: bool(_load_config().get("auto_update_host", True))),
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

  idle_icon = _load_icon()
  busy_icon = _make_busy_icon(idle_icon)
  icon = pystray.Icon("MangaUpscalerHost", idle_icon, "Manga Upscaler Host", menu)
  threading.Thread(target=_status_loop, args=(icon, ctl, idle_icon, busy_icon), daemon=True).start()
  threading.Thread(target=_update_loop, args=(icon, ctl), daemon=True).start()
  icon.run()


if __name__ == "__main__":
  raise SystemExit(main())
