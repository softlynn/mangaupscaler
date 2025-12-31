#!/usr/bin/env python3
"""
Manga Upscaler Local AI Host (MangaJaNai via Real-ESRGAN)

This starts a tiny local HTTP server on 127.0.0.1:48159 that the Chrome extension
can use to swap manga panel images to AI-enhanced versions without lagging the webpage.

Endpoints:
  GET /health
  GET /status
  GET /enhance?url=<img_url>&scale=2|3|4
  POST /enhance
  POST /config
  POST /cache/clear
  POST /models/download
  POST /shutdown

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
     Or download models only:
        python host_server.py --download-models [--allow-dat2]

If deps/models are missing, /enhance will return the original image (passthrough) plus
an X-MU-Host-Error header explaining what's missing.
"""
from __future__ import annotations
import hashlib, io, json, os, sys, threading, time, traceback, urllib.parse, re, types, importlib.util, importlib
from contextlib import contextmanager
from typing import TYPE_CHECKING
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from PIL import Image

if TYPE_CHECKING:
  import numpy as np

PORT = 48159
HOST = "127.0.0.1"

def _get_root_dir() -> str:
  if getattr(sys, "frozen", False):
    return os.path.dirname(sys.executable)
  return os.path.dirname(os.path.abspath(__file__))

ROOT = _get_root_dir()
CFG_PATH = os.path.join(ROOT, "config.json")
MODELS_DIR = os.path.join(ROOT, "models")
CACHE_DIR = os.path.join(ROOT, "cache")
CACHE_VERSION = 3
CACHE_CLEANUP_INTERVAL_SEC = 120
os.makedirs(CACHE_DIR, exist_ok=True)
WRAPPED_DIR = os.path.join(CACHE_DIR, "wrapped_models")
os.makedirs(WRAPPED_DIR, exist_ok=True)
LOG_PATH = os.path.join(ROOT, "host.log")

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
  "use_fp16": True,
  "grayscale_detection_threshold": 12,
  "residual_add": False,
  "residual_add_patterns": ["mangajanai", "illustrationjanai"],
  "residual_add_strength": 0.5,
  "cache_max_gb": 1.0,
  "cache_max_age_days": 0,
  "allow_dat2": False,
  "idle_shutdown_minutes": 5
}

QUALITY_PROFILES = {
  "fast": {"tile": 0, "tile_pad": 8, "pre_pad": 0, "half": True},
  # Balanced used to tile very aggressively (slow). Prefer no tiling on CUDA and
  # only fall back to tiling on OOM.
  "balanced": {"tile": 0, "tile_pad": 10, "pre_pad": 0, "half": True},
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
  for root, _, files in os.walk(MODELS_DIR):
    for fn in files:
      m = pat.match(fn)
      if not m:
        continue
      scale = m.group("scale")
      h = m.group("h")
      kind = m.group("kind").lower()
      model_type = "illustration" if "illustration" in kind else "manga"
      rel = os.path.relpath(os.path.join(root, fn), MODELS_DIR)
      out.setdefault(model_type, {}).setdefault(scale, {})[h] = rel
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
  for root, _, files in os.walk(MODELS_DIR):
    for fn in files:
      m = pat.match(fn)
      if not m:
        continue
      scale = m.group("scale")
      variant = m.group("variant").lower()
      q = "best" if "dat2" in variant else "balanced"
      rel = os.path.relpath(os.path.join(root, fn), MODELS_DIR)
      out.setdefault(scale, {})[q] = rel
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
  cfg.setdefault("grayscale_detection_threshold", 12)
  cfg.setdefault("residual_add", False)
  cfg.setdefault("residual_add_patterns", ["mangajanai", "illustrationjanai"])
  cfg.setdefault("residual_add_strength", 0.5)
  cfg.setdefault("cache_max_gb", 1.0)
  cfg.setdefault("cache_max_age_days", 0)
  cfg.setdefault("allow_dat2", False)
  cfg.setdefault("idle_shutdown_minutes", 5)

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

def save_cfg(cfg: dict) -> None:
  with open(CFG_PATH, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)

CFG = load_cfg()

def _log(msg: str) -> None:
  try:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
      f.write(f"[{ts}] {msg}\n")
  except Exception:
    pass

# Lazy-loaded model (kept in memory)
_engine = None
_engine_lock = threading.Lock()
_engine_key = None
_wrapped_cache: dict[str, str] = {}
_model_blocks: dict[str, int] = {}
_last_cache_cleanup = 0.0
_last_enhance_ts = 0.0
_idle_stop = threading.Event()
_active_enhances = 0
_active_enhances_lock = threading.Lock()

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
  if _is_dat2_filename(name) and (not CFG.get("allow_dat2", False) or not _dat_arch_available()):
    # DAT2 not supported in current deps; fall back to ESRGAN variant.
    alt_name = None
    for q2 in ("balanced", "fast"):
      for s in (str(scale), "4", "2"):
        qmap = mp.get(s, {})
        cand = qmap.get(q2)
        if cand and not _is_dat2_filename(cand):
          alt_name = cand
          break
      if alt_name:
        break
    if alt_name:
      name = alt_name
    else:
      return None
  path = os.path.join(MODELS_DIR, name)
  if not os.path.exists(path):
    return None
  return path

def _normalize_quality(q: str | None) -> str:
  q = (q or CFG.get("default_quality", "balanced")).strip().lower()
  return q if q in QUALITY_PROFILES else "balanced"

def _normalize_outscale(scale: int) -> int:
  try:
    scale = int(scale)
  except Exception:
    scale = int(CFG.get("default_scale", 2) or 2)
  return 2 if scale < 2 else 4 if scale > 4 else scale

def _normalize_output_format(fmt: str | None) -> str:
  fmt = (fmt or CFG.get("default_output_format", "png")).strip().lower()
  return "webp" if fmt in ("webp", "webpl", "webp-lossless", "webp_lossless") else "png"

def _cache_ext_for_format(fmt: str) -> str:
  return "webp" if fmt == "webp" else "png"

def _encode_output(out_img: Image.Image, fmt: str, is_gray: bool) -> tuple[bytes, str]:
  buf = io.BytesIO()
  if fmt == "webp":
    try:
      kwargs = {"format": "WEBP", "method": 4}
      if is_gray:
        kwargs.update({"lossless": True, "quality": 100})
      else:
        kwargs.update({"quality": 95})
      out_img.save(buf, **kwargs)
      return buf.getvalue(), "image/webp"
    except Exception as e:
      _log(f"WEBP encode failed; falling back to PNG: {e}")
      buf = io.BytesIO()
  # PNG optimize can be surprisingly slow on large images; favor speed.
  out_img.save(buf, format="PNG", compress_level=3)
  return buf.getvalue(), "image/png"

def _has_manga_scale(scale: int) -> bool:
  try:
    mp = CFG.get("model_map_by_type", {}).get("manga", {}).get(str(scale), {})
    return any(bool(v) for v in (mp or {}).values())
  except Exception:
    return False

def _model_scale_for_outscale(outscale: int, model_type: str, quality: str) -> int:
  # Prefer a native-scale model when possible. For 3x, use 2x Manga models + resize to 3x
  # for a large speedup vs running 4x and downscaling.
  if outscale == 2:
    if model_type == "manga" and _has_manga_scale(2):
      return 2
    # Illustration currently ships 4x models only.
    return 4
  if outscale == 3:
    if model_type == "manga" and _has_manga_scale(2):
      return 2
    # Illustration currently ships 4x models only.
    return 4
  return 4

def _is_dat2_filename(name: str) -> bool:
  return "dat2" in name.lower()

def _dat_arch_available() -> bool:
  return importlib.util.find_spec("basicsr.archs.dat_arch") is not None

def _convert_esrgan_state_dict(state: dict) -> dict:
  if not any(k.startswith("model.") for k in state.keys()):
    return state
  out: dict[str, object] = {}
  for k, v in state.items():
    if k.startswith("model.0."):
      nk = "conv_first." + k[len("model.0."):]
    elif k.startswith("model.1.sub."):
      suffix = k[len("model.1.sub."):]
      # model.1.sub.23.* is the conv_body in ESRGAN/RRDBNet.
      if ".RDB" not in suffix and (suffix.endswith(".weight") or suffix.endswith(".bias")):
        nk = "conv_body." + suffix.split(".", 1)[-1]
      else:
        nk = "body." + suffix
        nk = nk.replace(".RDB", ".rdb")
        nk = re.sub(r"\.conv(\d+)\.0\.", r".conv\1.", nk)
    elif k.startswith("model.3."):
      nk = "conv_up1." + k[len("model.3."):]
    elif k.startswith("model.6."):
      nk = "conv_up2." + k[len("model.6."):]
    elif k.startswith("model.8."):
      nk = "conv_hr." + k[len("model.8."):]
    elif k.startswith("model.10."):
      nk = "conv_last." + k[len("model.10."):]
    else:
      continue
    out[nk] = v
  return out

def _detect_num_blocks(state: dict) -> int | None:
  max_idx = -1
  for k in state.keys():
    if ".RDB" not in k and ".rdb" not in k:
      continue
    m = re.match(r"^(?:model\\.1\\.sub|body)\\.(\\d+)\\.", k)
    if not m:
      continue
    idx = int(m.group(1))
    if idx > max_idx:
      max_idx = idx
  return max_idx + 1 if max_idx >= 0 else None

def _ensure_conv_hr(state: dict) -> dict:
  if "conv_hr.weight" in state and "conv_hr.bias" in state:
    return state
  import torch
  for src in ("conv_up2", "conv_up1", "conv_body"):
    w_key = f"{src}.weight"
    b_key = f"{src}.bias"
    if w_key in state:
      state["conv_hr.weight"] = state[w_key].clone()
      if b_key in state:
        state["conv_hr.bias"] = state[b_key].clone()
      else:
        out_ch = state["conv_hr.weight"].shape[0]
        state["conv_hr.bias"] = torch.zeros(out_ch)
      break
  return state

def _wrap_model_if_needed(model_path: str) -> str:
  cached_path = _wrapped_cache.get(model_path)
  if cached_path:
    if os.path.exists(cached_path):
      if cached_path not in _model_blocks:
        import torch
        state = torch.load(cached_path, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and ("params" in state or "params_ema" in state):
          sd = state.get("params_ema") or state.get("params") or {}
        elif isinstance(state, dict) and "state_dict" in state:
          sd = state["state_dict"]
        else:
          sd = state
        num_blocks = _detect_num_blocks(sd) if isinstance(sd, dict) else None
        if num_blocks:
          _model_blocks[cached_path] = num_blocks
      return cached_path
    _wrapped_cache.pop(model_path, None)
  import torch
  state = torch.load(model_path, map_location="cpu", weights_only=True)
  if isinstance(state, dict) and ("params" in state or "params_ema" in state):
    sd = state.get("params_ema") or state.get("params") or {}
    needs_wrap = False
    if any(k.startswith("model.") for k in sd.keys()):
      sd = _convert_esrgan_state_dict(sd)
      needs_wrap = True
    if "conv_hr.weight" not in sd:
      sd = _ensure_conv_hr(sd)
      needs_wrap = True
    num_blocks = _detect_num_blocks(sd) if isinstance(sd, dict) else None
    if num_blocks:
      _model_blocks[model_path] = num_blocks
    if not needs_wrap:
      _wrapped_cache[model_path] = model_path
      return model_path
    state = sd
  else:
    if isinstance(state, dict) and "state_dict" in state:
      state = state["state_dict"]
    if not isinstance(state, dict):
      raise RuntimeError("Unsupported model file format")
    if any(k.startswith("model.") for k in state.keys()):
      state = _convert_esrgan_state_dict(state)
    if "conv_hr.weight" not in state:
      state = _ensure_conv_hr(state)
    num_blocks = _detect_num_blocks(state) if isinstance(state, dict) else None
    if num_blocks:
      _model_blocks[model_path] = num_blocks
  stat = os.stat(model_path)
  sig = f"{model_path}:{stat.st_size}:{int(stat.st_mtime)}:v4"
  h = hashlib.sha1(sig.encode("utf-8")).hexdigest()
  wrapped_path = os.path.join(WRAPPED_DIR, f"{h}.pth")
  if not os.path.exists(wrapped_path):
    torch.save({"params": state}, wrapped_path)
  _wrapped_cache[model_path] = wrapped_path
  if model_path in _model_blocks:
    _model_blocks[wrapped_path] = _model_blocks[model_path]
  return wrapped_path

def _ensure_torchvision_compat():
  if "torchvision.transforms.functional_tensor" in sys.modules:
    return
  try:
    if importlib.util.find_spec("torchvision.transforms.functional_tensor"):
      importlib.import_module("torchvision.transforms.functional_tensor")
      return
  except Exception:
    # Some environments raise when __spec__ is None; fall through to shim.
    pass
  try:
    F = importlib.import_module("torchvision.transforms.functional")
  except Exception:
    return

  mod = types.ModuleType("torchvision.transforms.functional_tensor")
  for name in dir(F):
    if not name.startswith("_"):
      setattr(mod, name, getattr(F, name))
  def _getattr(name):
    return getattr(F, name)
  mod.__getattr__ = _getattr  # type: ignore[attr-defined]
  mod.__spec__ = importlib.machinery.ModuleSpec(
    "torchvision.transforms.functional_tensor", loader=None
  )
  sys.modules["torchvision.transforms.functional_tensor"] = mod

def _load_engine(model_path: str, scale: int, quality: str):
  # Import heavy deps only when needed
  _ensure_torchvision_compat()
  import numpy as np
  import torch
  from basicsr.archs.rrdbnet_arch import RRDBNet
  from realesrgan import RealESRGANer

  # MangaJaNai V1 models are ESRGAN/RRDB-style.
  # Use RRDBNet like the Real-ESRGAN demo does for custom ESRGAN models.
  # (You can adjust in config.json if you use a different arch.)
  model_path = _wrap_model_if_needed(model_path)
  num_block = _model_blocks.get(model_path, 23)
  model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=num_block, num_grow_ch=32, scale=scale)

  prof = QUALITY_PROFILES.get(_normalize_quality(quality), QUALITY_PROFILES["balanced"])
  half = bool(CFG.get("use_fp16", True)) if prof["half"] else False
  device = "cuda" if torch.cuda.is_available() else "cpu"
  _log(f"Loading model {os.path.basename(model_path)} x{scale} {quality} device={device} fp16={half} tile={prof['tile']}")
  if device == "cpu":
    _log("CUDA not available; using CPU (slow). Reinstall Torch with CUDA in the host .venv.")
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
  # Resize for speed and compute color channel divergence while ignoring pure black/white.
  import numpy as np
  thumb = img.copy()
  thumb.thumbnail((96, 96))
  arr = np.asarray(thumb.convert("RGB"), dtype=np.uint8)
  if arr.ndim != 3 or arr.shape[2] < 3:
    return True
  r = arr[:, :, 0].astype(np.int16)
  g = arr[:, :, 1].astype(np.int16)
  b = arr[:, :, 2].astype(np.int16)

  threshold = int(CFG.get("grayscale_detection_threshold", 12))
  diff_rg = np.maximum(np.abs(r - g) - threshold, 0)
  diff_rb = np.maximum(np.abs(r - b) - threshold, 0)
  diff_gb = np.maximum(np.abs(g - b) - threshold, 0)

  pure_black = (r == 0) & (g == 0) & (b == 0)
  pure_white = (r == 255) & (g == 255) & (b == 255)
  exclude = pure_black | pure_white

  diff_sum = (diff_rg + diff_rb + diff_gb)
  diff_sum = diff_sum[~exclude].sum()
  size_wo = (~exclude).sum() * 3
  if size_wo == 0:
    return False
  ratio = diff_sum / size_wo
  return ratio <= (threshold / 12.0)

def _should_apply_residual(model_path: str) -> bool:
  if not CFG.get("residual_add", True):
    return False
  strength = float(CFG.get("residual_add_strength", 1.0) or 0)
  if strength <= 0:
    return False
  patterns = CFG.get("residual_add_patterns") or []
  name = os.path.basename(model_path).lower()
  return any(pat.lower() in name for pat in patterns)

def _apply_residual_add(out_rgb, src_img: Image.Image, strength: float) -> np.ndarray:
  import numpy as np
  base = src_img.resize((out_rgb.shape[1], out_rgb.shape[0]), resample=Image.BICUBIC)
  base_np = np.asarray(base, dtype=np.float32)
  out_np = out_rgb.astype(np.float32)
  res = base_np + out_np * float(strength)
  return np.clip(res, 0, 255).astype(np.uint8)

def _iter_cache_files(include_wrapped: bool = False):
  wrapped = os.path.abspath(WRAPPED_DIR)
  root_abs = os.path.abspath(CACHE_DIR)
  for root, dirs, files in os.walk(root_abs):
    if not include_wrapped:
      dirs[:] = [d for d in dirs if os.path.abspath(os.path.join(root, d)) != wrapped and d != "wrapped_models"]
    for fn in files:
      path = os.path.join(root, fn)
      if not include_wrapped and os.path.abspath(path).startswith(wrapped):
        continue
      try:
        st = os.stat(path)
      except OSError:
        continue
      yield path, st.st_size, st.st_mtime

def _cleanup_cache_if_needed(force: bool = False) -> None:
  global _last_cache_cleanup
  now = time.time()
  if not force and (now - _last_cache_cleanup) < CACHE_CLEANUP_INTERVAL_SEC:
    return
  _last_cache_cleanup = now

  max_gb = float(CFG.get("cache_max_gb", 1.0) or 0)
  max_bytes = int(max_gb * (1024 ** 3)) if max_gb > 0 else 0
  max_age_days = int(CFG.get("cache_max_age_days", 0) or 0)
  cutoff = now - (max_age_days * 86400) if max_age_days > 0 else 0

  files = list(_iter_cache_files(include_wrapped=False))

  # Age-based cleanup
  if cutoff > 0:
    for path, _, mtime in files:
      if mtime < cutoff:
        try:
          os.remove(path)
        except OSError:
          pass
    files = list(_iter_cache_files(include_wrapped=False))

  # Size-based cleanup
  if max_bytes > 0:
    total = sum(size for _, size, _ in files)
    if total > max_bytes:
      files.sort(key=lambda x: x[2])  # oldest first
      for path, size, _ in files:
        try:
          os.remove(path)
        except OSError:
          pass
        total -= size
        if total <= max_bytes:
          break

def _clear_cache(include_wrapped: bool = False) -> int:
  removed = 0
  for path, _, _ in _iter_cache_files(include_wrapped=include_wrapped):
    try:
      os.remove(path)
      removed += 1
    except OSError:
      pass
  return removed

def _touch_enhance():
  global _last_enhance_ts
  _last_enhance_ts = time.time()

@contextmanager
def _enhance_activity():
  global _active_enhances
  with _active_enhances_lock:
    _active_enhances += 1
  try:
    yield
  finally:
    with _active_enhances_lock:
      _active_enhances = max(0, _active_enhances - 1)

def _status_payload() -> dict:
  with _active_enhances_lock:
    active = int(_active_enhances)
  return {
    "ok": True,
    "busy": active > 0,
    "active": active,
    "idle_seconds": max(0.0, time.time() - float(_last_enhance_ts or 0.0)),
  }

def _get_idle_minutes() -> float:
  try:
    return float(CFG.get("idle_shutdown_minutes", 5) or 0)
  except Exception:
    return 0.0

def _idle_monitor(httpd):
  while not _idle_stop.is_set():
    minutes = _get_idle_minutes()
    if minutes <= 0:
      _idle_stop.wait(5)
      continue
    idle_for = time.time() - _last_enhance_ts
    if idle_for >= (minutes * 60):
      try:
        httpd.shutdown()
      except Exception:
        pass
      return
    _idle_stop.wait(5)

def _download_models(allow_dat2: bool) -> dict:
  os.makedirs(MODELS_DIR, exist_ok=True)
  api_url = "https://api.github.com/repos/the-database/MangaJaNai/releases/tags/1.0.0"
  r = requests.get(api_url, timeout=30)
  r.raise_for_status()
  data = r.json()
  assets = {a.get("name"): a.get("browser_download_url") for a in data.get("assets", [])}
  wanted = [
    "MangaJaNai_V1_ModelsOnly.zip",
    "IllustrationJaNai_V1_ModelsOnly.zip"
  ]

  imported = []
  for name in wanted:
    url = assets.get(name)
    if not url:
      continue
    tmp_zip = os.path.join(CACHE_DIR, f"dl_{name}")
    with requests.get(url, stream=True, timeout=120) as resp:
      resp.raise_for_status()
      with open(tmp_zip, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
          if chunk:
            f.write(chunk)
    import zipfile
    with zipfile.ZipFile(tmp_zip, "r") as zf:
      zf.extractall(MODELS_DIR)
    try:
      os.remove(tmp_zip)
    except OSError:
      pass
    imported.append(name)

  if not allow_dat2:
    for root, _, files in os.walk(MODELS_DIR):
      for fn in files:
        if _is_dat2_filename(fn):
          try:
            os.remove(os.path.join(root, fn))
          except OSError:
            pass

  # Refresh config scans so new models are visible.
  global CFG
  CFG = load_cfg()
  return {"imported": imported}

def _choose_model_type(is_grayscale: bool) -> str:
  if is_grayscale:
    return "manga"
  # prefer illustration if any are available
  illu = CFG.get("model_map_by_type", {}).get("illustration", {})
  illu_q = CFG.get("illustration_by_quality", {})
  has_illu = any(bool(v) for v in illu.values()) or any(bool(v) for v in illu_q.values())
  return "illustration" if has_illu else "manga"

def enhance_bytes(img_bytes: bytes, outscale: int, quality: str | None, out_format: str | None = None) -> tuple[bytes, str, str]:
  global _engine, _engine_key
  img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
  w, h = img.size

  # Choose model by grayscale detection + input height.
  is_gray = _detect_grayscale(img)
  model_type = _choose_model_type(is_gray)
  q = _normalize_quality(quality)
  outscale = _normalize_outscale(outscale)
  fmt = _normalize_output_format(out_format)
  model_path = None
  height_key = None
  model_scale = _model_scale_for_outscale(outscale, model_type, q)
  if model_type == "illustration":
    model_path = _get_illustration_model_path(model_scale, q)
    if not model_path:
      model_type = "manga"
  if not model_path:
    height_key = _pick_height(h, model_scale, model_type)
    model_path = _get_model_path(height_key, model_scale, model_type)
  key = f"{model_path}::x{model_scale}::q={q}"

  with _engine_lock:
    if _engine is None or _engine_key != key:
      _engine = _load_engine(model_path, model_scale, q)
      _engine_key = key
    engine = _engine

  import numpy as np
  in_img = np.array(img)[:, :, ::-1]  # RGB -> BGR
  prev_tile = getattr(engine, "tile_size", 0)
  engine.tile_size = QUALITY_PROFILES.get(q, QUALITY_PROFILES["balanced"]).get("tile", 0) or 0
  try:
    out, _ = engine.enhance(in_img, outscale=outscale)
  except Exception as e:
    msg = str(e).lower()
    if "out of memory" in msg or "cuda out of memory" in msg:
      # Retry once with tiling (common on huge pages).
      try:
        _log("CUDA OOM; retrying with tile_size=512")
        engine.tile_size = 512
        out, _ = engine.enhance(in_img, outscale=outscale)
      except Exception:
        raise
    else:
      raise
  finally:
    try:
      engine.tile_size = prev_tile
    except Exception:
      pass

  out_rgb = out[:, :, ::-1]
  resid_tag = ""
  if _should_apply_residual(model_path):
    out_rgb = _apply_residual_add(out_rgb, img, CFG.get("residual_add_strength", 1.0))
    resid_tag = " resid"
  out_img = Image.fromarray(out_rgb)

  out_bytes, ctype = _encode_output(out_img, fmt, is_gray)
  if height_key:
    label = f"{model_type}:{height_key}p x{outscale} {q}{resid_tag}"
  else:
    label = f"{model_type}:{q} x{outscale}{resid_tag}"
  return out_bytes, label, ctype

class Handler(BaseHTTPRequestHandler):
  def log_message(self, fmt, *args):
    try:
      if self.path.startswith("/health") or self.path.startswith("/status"):
        return
    except Exception:
      pass
    try:
      _log(fmt % args)
    except Exception:
      pass

  def _send(self, code: int, body: bytes, ctype: str="text/plain", extra_headers: dict|None=None):
    try:
      self.send_response(code)
      self.send_header("Content-Type", ctype)
      self.send_header("Cache-Control", "no-store")
      if extra_headers:
        for k,v in extra_headers.items():
          self.send_header(k, v)
      self.end_headers()
      self.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
      return
    except OSError as e:
      if getattr(e, "winerror", None) in (10053, 10054) or e.errno in (32, 104):
        return
      raise

  def do_GET(self):
    try:
      parsed = urllib.parse.urlparse(self.path)
      if parsed.path == "/health":
        return self._send(200, b"ok")
      if parsed.path == "/status":
        body = json.dumps(_status_payload()).encode("utf-8")
        return self._send(200, body, "application/json")
      if parsed.path != "/enhance":
        return self._send(404, b"not found")
      with _enhance_activity():
        _touch_enhance()

        qs = urllib.parse.parse_qs(parsed.query or "")
        url = (qs.get("url") or [""])[0]
        outscale = int((qs.get("scale") or [CFG.get("default_scale", 2)])[0])
        outscale = _normalize_outscale(outscale)
        quality = (qs.get("quality") or [CFG.get("default_quality", "balanced")])[0]
        out_fmt = _normalize_output_format((qs.get("format") or qs.get("fmt") or [None])[0])

        if not url:
          return self._send(400, b"missing url")

        # Simple disk cache keyed by url+scale+quality+format
        _cleanup_cache_if_needed()
        cache_ext = _cache_ext_for_format(out_fmt)
        cache_key = str(abs(hash(f"v{CACHE_VERSION}::{url}::{outscale}::{quality}::{out_fmt}")))
        cache_path = os.path.join(CACHE_DIR, f"{cache_key}.{cache_ext}")
        if os.path.exists(cache_path):
          with open(cache_path, "rb") as f:
            ctype = "image/webp" if cache_ext == "webp" else "image/png"
            return self._send(200, f.read(), ctype, {"X-MU-Model":"cache"})

        # Download
        r = requests.get(url, timeout=20, headers={"User-Agent":"MangaUpscalerHost/1.0"})
        r.raise_for_status()
        src_bytes = r.content

        # Try enhance, fallback to passthrough if missing deps/models
        try:
          out_bytes, model_name, ctype = enhance_bytes(src_bytes, outscale, quality, out_fmt)
          with open(cache_path, "wb") as f:
            f.write(out_bytes)
          return self._send(200, out_bytes, ctype, {"X-MU-Model": model_name})
        except Exception as e:
          # passthrough original image
          err = (str(e) or e.__class__.__name__).encode("utf-8", "ignore")[:400]
          _log(f"enhance failed (GET): {err.decode('utf-8','ignore')}")
          ctype = r.headers.get("content-type","application/octet-stream").split(";")[0]
          return self._send(200, src_bytes, ctype, {"X-MU-Host-Error": err.decode("utf-8","ignore")})

    except Exception as e:
      tb = traceback.format_exc()
      _log(tb)
      self._send(500, tb.encode("utf-8","ignore")[:8000])

  def do_POST(self):
    try:
      parsed = urllib.parse.urlparse(self.path)
      if parsed.path == "/shutdown":
        if self.client_address[0] not in ("127.0.0.1", "::1"):
          return self._send(403, b"forbidden")
        threading.Thread(target=self.server.shutdown, daemon=True).start()
        return self._send(200, b"ok")
      if parsed.path == "/cache/clear":
        length = int(self.headers.get("Content-Length", "0"))
        include_wrapped = False
        if length > 0:
          try:
            payload = json.loads(self.rfile.read(length))
            include_wrapped = bool(payload.get("include_wrapped", False))
          except Exception:
            include_wrapped = False
        removed = _clear_cache(include_wrapped=include_wrapped)
        body = json.dumps({"ok": True, "removed": removed}).encode("utf-8")
        return self._send(200, body, "application/json")

      if parsed.path == "/config":
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
          return self._send(400, b"missing body")
        payload = json.loads(self.rfile.read(length))
        global CFG
        cfg = dict(CFG)
        for key in ("cache_max_gb", "cache_max_age_days", "allow_dat2", "idle_shutdown_minutes"):
          if key in payload:
            cfg[key] = payload[key]
        CFG = _normalize_cfg(cfg)
        save_cfg(CFG)
        body = json.dumps({"ok": True}).encode("utf-8")
        return self._send(200, body, "application/json")

      if parsed.path == "/models/download":
        length = int(self.headers.get("Content-Length", "0"))
        allow_dat2 = bool(CFG.get("allow_dat2", False))
        if length > 0:
          try:
            payload = json.loads(self.rfile.read(length))
            allow_dat2 = bool(payload.get("allow_dat2", allow_dat2))
          except Exception:
            pass
        result = _download_models(allow_dat2=allow_dat2)
        body = json.dumps({"ok": True, **result}).encode("utf-8")
        return self._send(200, body, "application/json")

      if parsed.path != "/enhance":
        return self._send(404, b"not found")
      with _enhance_activity():
        _touch_enhance()

        qs = urllib.parse.parse_qs(parsed.query or "")
        outscale = int((qs.get("scale") or [CFG.get("default_scale", 2)])[0])
        outscale = _normalize_outscale(outscale)
        quality = (qs.get("quality") or [CFG.get("default_quality", "balanced")])[0]
        out_fmt = _normalize_output_format((qs.get("format") or qs.get("fmt") or [None])[0])

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
          return self._send(400, b"missing body")
        src_bytes = self.rfile.read(length)
        if not src_bytes:
          return self._send(400, b"empty body")

        # Cache by content hash + scale + quality + format
        _cleanup_cache_if_needed()
        cache_ext = _cache_ext_for_format(out_fmt)
        h = hashlib.sha1(src_bytes + f"::{outscale}::{quality}::{out_fmt}::v{CACHE_VERSION}".encode("utf-8")).hexdigest()
        cache_path = os.path.join(CACHE_DIR, f"{h}.{cache_ext}")
        if os.path.exists(cache_path):
          with open(cache_path, "rb") as f:
            ctype = "image/webp" if cache_ext == "webp" else "image/png"
            return self._send(200, f.read(), ctype, {"X-MU-Model":"cache"})

        try:
          out_bytes, model_name, ctype = enhance_bytes(src_bytes, outscale, quality, out_fmt)
          with open(cache_path, "wb") as f:
            f.write(out_bytes)
          return self._send(200, out_bytes, ctype, {"X-MU-Model": model_name})
        except Exception as e:
          err = (str(e) or e.__class__.__name__).encode("utf-8", "ignore")[:400]
          _log(f"enhance failed (POST): {err.decode('utf-8','ignore')}")
          return self._send(200, src_bytes, "application/octet-stream", {"X-MU-Host-Error": err.decode("utf-8","ignore")})
    except Exception:
      tb = traceback.format_exc()
      _log(tb)
      self._send(500, tb.encode("utf-8","ignore")[:8000])

def create_httpd():
  return ThreadingHTTPServer((HOST, PORT), Handler)

def start_http_server():
  global _last_enhance_ts, _idle_stop
  _last_enhance_ts = time.time()
  _idle_stop = threading.Event()
  httpd = create_httpd()
  thread = threading.Thread(target=httpd.serve_forever, daemon=True)
  thread.start()
  threading.Thread(target=_idle_monitor, args=(httpd,), daemon=True).start()
  return httpd, thread

def stop_http_server(httpd):
  _idle_stop.set()
  if not httpd:
    return
  httpd.shutdown()
  httpd.server_close()

def main():
  if "--download-models" in sys.argv:
    allow_dat2 = "--allow-dat2" in sys.argv
    result = _download_models(allow_dat2=allow_dat2)
    print(json.dumps({"ok": True, **result}))
    return

  print(f"[MangaUpscalerHost] listening on http://{HOST}:{PORT}")
  global _last_enhance_ts, _idle_stop
  _last_enhance_ts = time.time()
  _idle_stop = threading.Event()
  httpd = create_httpd()
  threading.Thread(target=_idle_monitor, args=(httpd,), daemon=True).start()
  httpd.serve_forever()

if __name__ == "__main__":
  main()
