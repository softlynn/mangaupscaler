#!/usr/bin/env python3
"""
Manga Upscaler Local AI Host (MangaJaNai via Real-ESRGAN)

This starts a tiny local HTTP server on 127.0.0.1:48159 that the Chrome extension
can use to swap manga panel images to AI-enhanced versions without lagging the webpage.

Endpoints:
  GET /health
  GET /enhance?url=<img_url>&scale=2|3|4

Setup (Windows, simplest):
  1) Install Python 3.10+
  2) Create a venv:
        py -3.10 -m venv .venv
        .venv\\Scripts\\activate
  3) Install deps (Torch is big; choose the CUDA build that matches your GPU/driver):
        pip install --upgrade pip
        pip install pillow numpy requests
        pip install realesrgan basicsr
        # then install torch separately from pytorch.org with CUDA support
  4) Download MangaJaNai model .pth files into ./models/
     (See the-database/MangaJaNai releases for model names.)
  5) Edit config.json if you want different model mapping.
  6) Run:
        python host_server.py

If deps/models are missing, /enhance will return the original image (passthrough) plus
an X-MU-Host-Error header explaining what’s missing.
"""
from __future__ import annotations
import hashlib, io, json, os, sys, threading, time, traceback, urllib.parse, re, types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from PIL import Image

PORT = 48159
HOST = "127.0.0.1"
ROOT = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(ROOT, "config.json")
MODELS_DIR = os.path.join(ROOT, "models")
CACHE_DIR = os.path.join(ROOT, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

DEFAULT_CFG = {
  "auto_scan_models": True,
  "model_map_by_type": {
    "manga": {
      "2": {
        "1200": "2x_MangaJaNai_1200p_V1_ESRGAN_70k.pth",
        "1300": "2x_MangaJaNai_1300p_V1_ESRGAN_75k.pth",
        "1400": "2x_MangaJaNai_1400p_V1_ESRGAN_70k.pth",
        "1500": "2x_MangaJaNai_1500p_V1_ESRGAN_90k.pth",
        "1600": "2x_MangaJaNai_1600p_V1_ESRGAN_90k.pth",
        "1920": "2x_MangaJaNai_1920p_V1_ESRGAN_70k.pth",
        "2048": "2x_MangaJaNai_2048p_V1_ESRGAN_95k.pth"
      },
      "4": {
        "1200": "4x_MangaJaNai_1200p_V1_ESRGAN_70k.pth",
        "1300": "4x_MangaJaNai_1300p_V1_ESRGAN_75k.pth",
        "1400": "4x_MangaJaNai_1400p_V1_ESRGAN_105k.pth",
        "1500": "4x_MangaJaNai_1500p_V1_ESRGAN_105k.pth",
        "1600": "4x_MangaJaNai_1600p_V1_ESRGAN_70k.pth",
        "1920": "4x_MangaJaNai_1920p_V1_ESRGAN_105k.pth",
        "2048": "4x_MangaJaNai_2048p_V1_ESRGAN_70k.pth"
      }
    },
    "illustration": {
      "2": {},
      "4": {}
    }
  },
  "illustration_by_quality": {
    "4": {
      "fast": "4x_IllustrationJaNai_V1_ESRGAN_135k.pth",
      "balanced": "4x_IllustrationJaNai_V1_ESRGAN_135k.pth",
      "best": "4x_IllustrationJaNai_V1_DAT2_190k.pth"
    }
  },
  "default_scale": 2,
  "default_quality": "balanced",
  "use_fp16": True
}

QUALITY_PROFILES = {
  "fast": {"tile": 0, "tile_pad": 8, "pre_pad": 0, "half": True},
  "balanced": {"tile": 200, "tile_pad": 10, "pre_pad": 0, "half": True},
  "best": {"tile": 0, "tile_pad": 10, "pre_pad": 0, "half": False}
}


def _scan_models_dir() -> dict[str, dict[str, dict[str, str]]]:
  """
  Scan ./models for MangaJaNai/IllustrationJaNai .pth filenames and build a map:
    {"manga": {"2": {"1600": "2x_MangaJaNai_1600p_....pth", ...}},
     "illustration": {"4": {"1600": "4x_IllustrationJaNai_1600p_....pth", ...}}}
  """
  out: dict[str, dict[str, dict[str, str]]] = {}
  if not os.path.isdir(MODELS_DIR):
    return out
  pat = re.compile(r"^(?P<scale>[24])x_(?P<kind>MangaJaNai|IllustrationJaNai)_(?P<h>\d+)p_.*\.pth$", re.IGNORECASE)
  for fn in os.listdir(MODELS_DIR):
    m = pat.match(fn)
    if not m:
      continue
    scale = m.group("scale")
    h = m.group("h")
    kind = m.group("kind").lower()
    model_type = "illustration" if "illustration" in kind else "manga"
    out.setdefault(model_type, {}).setdefault(scale, {})[h] = fn
  return out


def _scan_illustration_quality_models() -> dict[str, dict[str, str]]:
  """
  Scan ./models for IllustrationJaNai V1 quality variants:
    4x_IllustrationJaNai_V1_ESRGAN_135k.pth -> balanced/fast
    4x_IllustrationJaNai_V1_DAT2_190k.pth   -> best
  """
  out: dict[str, dict[str, str]] = {}
  if not os.path.isdir(MODELS_DIR):
    return out
  pat = re.compile(r"^(?P<scale>[24])x_IllustrationJaNai_V1_(?P<variant>ESRGAN|DAT2)_\d+k\.pth$", re.IGNORECASE)
  for fn in os.listdir(MODELS_DIR):
    m = pat.match(fn)
    if not m:
      continue
    scale = m.group("scale")
    variant = m.group("variant").lower()
    q = "best" if "dat2" in variant else "balanced"
    out.setdefault(scale, {})[q] = fn
  for scale, mp in out.items():
    if "balanced" in mp and "fast" not in mp:
      mp["fast"] = mp["balanced"]
    if "fast" in mp and "balanced" not in mp:
      mp["balanced"] = mp["fast"]
  return out


def _normalize_cfg(cfg: dict) -> dict:
  # Back-compat: allow older "model_map" (assumed 2x)
  if "model_map_by_type" not in cfg:
    if "model_map_by_scale" in cfg:
      cfg["model_map_by_type"] = {"manga": cfg.get("model_map_by_scale", {}), "illustration": {}}
    elif "model_map" in cfg:
      cfg["model_map_by_type"] = {"manga": {"2": cfg.get("model_map", {})}, "illustration": {}}
  cfg.setdefault("model_map_by_type", {"manga": {}, "illustration": {}})
  cfg.setdefault("illustration_by_quality", {})
  cfg.setdefault("auto_scan_models", True)
  cfg.setdefault("default_scale", 2)
  cfg.setdefault("default_quality", "balanced")
  cfg.setdefault("use_fp16", True)

  if cfg.get("auto_scan_models", True):
    scanned = _scan_models_dir()
    # Merge: scanned wins if present (since it reflects what's actually installed)
    for model_type, scales in scanned.items():
      cfg["model_map_by_type"].setdefault(model_type, {})
      for scale, mp in scales.items():
        cfg["model_map_by_type"][model_type].setdefault(scale, {})
        cfg["model_map_by_type"][model_type][scale].update(mp)
    scanned_q = _scan_illustration_quality_models()
    for scale, mp in scanned_q.items():
      cfg["illustration_by_quality"].setdefault(scale, {})
      cfg["illustration_by_quality"][scale].update(mp)

  for scale, mp in cfg.get("illustration_by_quality", {}).items():
    if "balanced" in mp and "fast" not in mp:
      mp["fast"] = mp["balanced"]
    if "fast" in mp and "balanced" not in mp:
      mp["balanced"] = mp["fast"]

  return cfg


def load_cfg():
  if not os.path.exists(CFG_PATH):
    with open(CFG_PATH, "w", encoding="utf-8") as f:
      json.dump(DEFAULT_CFG, f, indent=2)
  with open(CFG_PATH, "r", encoding="utf-8") as f:
    cfg = json.load(f)
  return _normalize_cfg(cfg)

CFG = load_cfg()

# Lazy-loaded model (kept in memory)
_engine = None
_engine_lock = threading.Lock()
_engine_key = None

def _pick_height(h: int, scale: int, model_type: str) -> int:
  mp = CFG.get("model_map_by_type", {}).get(model_type, {}).get(str(scale), {})
  choices = sorted(int(k) for k in mp.keys())
  if not choices:
    # fall back to any available scale in this type
    for s in ("4", "2"):
      mp2 = CFG.get("model_map_by_type", {}).get(model_type, {}).get(s, {})
      choices2 = sorted(int(k) for k in mp2.keys())
      if choices2:
        return min(choices2, key=lambda x: abs(x - h))
    return 1600
  return min(choices, key=lambda x: abs(x - h))

def _get_model_path(height_key: int, scale: int, model_type: str) -> str:
  mp = CFG.get("model_map_by_type", {}).get(model_type, {}).get(str(scale), {})
  name = mp.get(str(height_key))
  if not name:
    # fall back to any scale that has this height within this type
    for s in ("4", "2"):
      mp2 = CFG.get("model_map_by_type", {}).get(model_type, {}).get(s, {})
      if str(height_key) in mp2:
        name = mp2[str(height_key)]
        break
  if not name and model_type != "manga":
    # fall back to manga as a safe default
    return _get_model_path(height_key, scale, "manga")
  if not name:
    raise RuntimeError("No model mapped for height " + str(height_key) + " at scale x" + str(scale))
  path = os.path.join(MODELS_DIR, name)
  if not os.path.exists(path):
    raise RuntimeError("Model file not found: " + path)
  return path

def _get_illustration_model_path(scale: int, quality: str) -> str | None:
  mp = CFG.get("illustration_by_quality", {})
  if not mp:
    return None
  q = _normalize_quality(quality)

  def pick(scale_key: str) -> str | None:
    qmap = mp.get(scale_key, {})
    if not qmap:
      return None
    return qmap.get(q) or qmap.get("balanced") or qmap.get("fast") or qmap.get("best")

  name = pick(str(scale))
  if not name:
    for s in ("4", "2"):
      name = pick(s)
      if name:
        break
  if not name:
    return None
  path = os.path.join(MODELS_DIR, name)
  if not os.path.exists(path):
    return None
  return path

def _normalize_quality(q: str | None) -> str:
  q = (q or CFG.get("default_quality", "balanced")).strip().lower()
  return q if q in QUALITY_PROFILES else "balanced"

def _normalize_scale(scale: int) -> int:
  return 2 if scale <= 2 else 4

def _ensure_torchvision_compat():
  try:
    import torchvision.transforms.functional_tensor  # noqa: F401
    return
  except Exception:
    pass
  try:
    import torchvision.transforms.functional as F
  except Exception:
    return

  mod = types.ModuleType("torchvision.transforms.functional_tensor")
  for name in dir(F):
    if not name.startswith("_"):
      setattr(mod, name, getattr(F, name))
  def _getattr(name):
    return getattr(F, name)
  mod.__getattr__ = _getattr  # type: ignore[attr-defined]
  sys.modules["torchvision.transforms.functional_tensor"] = mod

def _load_engine(model_path: str, scale: int, quality: str):
  # Import heavy deps only when needed
  _ensure_torchvision_compat()
  import numpy as np
  from basicsr.archs.rrdbnet_arch import RRDBNet
  from realesrgan import RealESRGANer

  # MangaJaNai V1 models are ESRGAN/RRDB-style.
  # Use RRDBNet like the Real-ESRGAN demo does for custom ESRGAN models.
  # (You can adjust in config.json if you use a different arch.)
  model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=scale)

  prof = QUALITY_PROFILES.get(_normalize_quality(quality), QUALITY_PROFILES["balanced"])
  half = bool(CFG.get("use_fp16", True)) if prof["half"] else False
  engine = RealESRGANer(
    scale=scale,
    model_path=model_path,
    model=model,
    tile=prof["tile"],
    tile_pad=prof["tile_pad"],
    pre_pad=prof["pre_pad"],
    half=half,
    gpu_id=0
  )
  return engine

def _detect_grayscale(img: Image.Image) -> bool:
  # Resize for speed and compute average channel spread.
  thumb = img.copy()
  thumb.thumbnail((96, 96))
  pix = thumb.convert("RGB").getdata()
  total = 0
  colorful = 0
  count = 0
  for r, g, b in pix:
    mx = max(r, g, b)
    mn = min(r, g, b)
    diff = mx - mn
    total += diff
    count += 1
    if diff > 18:
      colorful += 1
  if count == 0:
    return True
  avg = total / count
  ratio = colorful / count
  return avg < 7 or ratio < 0.03

def _choose_model_type(is_grayscale: bool) -> str:
  if is_grayscale:
    return "manga"
  # prefer illustration if any are available
  illu = CFG.get("model_map_by_type", {}).get("illustration", {})
  illu_q = CFG.get("illustration_by_quality", {})
  has_illu = any(bool(v) for v in illu.values()) or any(bool(v) for v in illu_q.values())
  return "illustration" if has_illu else "manga"

def enhance_bytes(img_bytes: bytes, scale: int, quality: str | None) -> tuple[bytes, str]:
  global _engine, _engine_key
  img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
  w, h = img.size

  # Choose model by grayscale detection + input height.
  is_gray = _detect_grayscale(img)
  model_type = _choose_model_type(is_gray)
  q = _normalize_quality(quality)
  model_path = None
  height_key = None
  if model_type == "illustration":
    model_path = _get_illustration_model_path(scale, q)
    if not model_path:
      model_type = "manga"
  if not model_path:
    height_key = _pick_height(h, scale, model_type)
    model_path = _get_model_path(height_key, scale, model_type)
  key = f"{model_path}::x{scale}::q={q}"

  with _engine_lock:
    if _engine is None or _engine_key != key:
      _engine = _load_engine(model_path, scale, q)
      _engine_key = key
    engine = _engine

  import numpy as np
  in_img = np.array(img)[:, :, ::-1]  # RGB -> BGR
  out, _ = engine.enhance(in_img, outscale=scale)
  out_rgb = out[:, :, ::-1]
  out_img = Image.fromarray(out_rgb)

  buf = io.BytesIO()
  out_img.save(buf, format="PNG", optimize=True)
  if height_key:
    label = f"{model_type}:{height_key}p x{scale} {q}"
  else:
    label = f"{model_type}:{q} x{scale}"
  return buf.getvalue(), label

class Handler(BaseHTTPRequestHandler):
  def _send(self, code: int, body: bytes, ctype: str="text/plain", extra_headers: dict|None=None):
    self.send_response(code)
    self.send_header("Content-Type", ctype)
    self.send_header("Cache-Control", "no-store")
    if extra_headers:
      for k,v in extra_headers.items():
        self.send_header(k, v)
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    try:
      parsed = urllib.parse.urlparse(self.path)
      if parsed.path == "/health":
        return self._send(200, b"ok")
      if parsed.path != "/enhance":
        return self._send(404, b"not found")

      qs = urllib.parse.parse_qs(parsed.query or "")
      url = (qs.get("url") or [""])[0]
      scale = int((qs.get("scale") or [CFG.get("default_scale", 2)])[0])
      scale = _normalize_scale(scale)
      quality = (qs.get("quality") or [CFG.get("default_quality", "balanced")])[0]

      if not url:
        return self._send(400, b"missing url")

      # Simple disk cache keyed by url+scale
      cache_key = str(abs(hash(f"{url}::{scale}::{quality}")))
      cache_path = os.path.join(CACHE_DIR, f"{cache_key}.png")
      if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
          return self._send(200, f.read(), "image/png", {"X-MU-Model":"cache"})

      # Download
      r = requests.get(url, timeout=20, headers={"User-Agent":"MangaUpscalerHost/1.0"})
      r.raise_for_status()
      src_bytes = r.content

      # Try enhance, fallback to passthrough if missing deps/models
      try:
        out_bytes, model_name = enhance_bytes(src_bytes, scale, quality)
        with open(cache_path, "wb") as f:
          f.write(out_bytes)
        return self._send(200, out_bytes, "image/png", {"X-MU-Model": model_name})
      except Exception as e:
        # passthrough original image
        err = (str(e) or e.__class__.__name__).encode("utf-8", "ignore")[:400]
        ctype = r.headers.get("content-type","application/octet-stream").split(";")[0]
        return self._send(200, src_bytes, ctype, {"X-MU-Host-Error": err.decode("utf-8","ignore")})

    except Exception as e:
      tb = traceback.format_exc()
      self._send(500, tb.encode("utf-8","ignore")[:8000])

  def do_POST(self):
    try:
      parsed = urllib.parse.urlparse(self.path)
      if parsed.path != "/enhance":
        return self._send(404, b"not found")

      qs = urllib.parse.parse_qs(parsed.query or "")
      scale = int((qs.get("scale") or [CFG.get("default_scale", 2)])[0])
      scale = _normalize_scale(scale)
      quality = (qs.get("quality") or [CFG.get("default_quality", "balanced")])[0]

      length = int(self.headers.get("Content-Length", "0"))
      if length <= 0:
        return self._send(400, b"missing body")
      src_bytes = self.rfile.read(length)
      if not src_bytes:
        return self._send(400, b"empty body")

      # Cache by content hash + scale + quality
      h = hashlib.sha1(src_bytes + f"::{scale}::{quality}".encode("utf-8")).hexdigest()
      cache_path = os.path.join(CACHE_DIR, f"{h}.png")
      if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
          return self._send(200, f.read(), "image/png", {"X-MU-Model":"cache"})

      try:
        out_bytes, model_name = enhance_bytes(src_bytes, scale, quality)
        with open(cache_path, "wb") as f:
          f.write(out_bytes)
        return self._send(200, out_bytes, "image/png", {"X-MU-Model": model_name})
      except Exception as e:
        err = (str(e) or e.__class__.__name__).encode("utf-8", "ignore")[:400]
        return self._send(200, src_bytes, "application/octet-stream", {"X-MU-Host-Error": err.decode("utf-8","ignore")})
    except Exception:
      tb = traceback.format_exc()
      self._send(500, tb.encode("utf-8","ignore")[:8000])

def main():
  print(f"[MangaUpscalerHost] listening on http://{HOST}:{PORT}")
  httpd = ThreadingHTTPServer((HOST, PORT), Handler)
  httpd.serve_forever()

if __name__ == "__main__":
  main()
