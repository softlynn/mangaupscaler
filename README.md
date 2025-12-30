# MangaUpscaler

Chrome extension + local AI host for manga enhancement. The extension detects the
current panel in view and sends it to the local host, which upscales using
Real-ESRGAN with MangaJaNai/IllustrationJaNai models.

## Features
- Auto-detect grayscale vs color panels
- Auto-select MangaJaNai or IllustrationJaNai
- Model switching based on input height
- Quality modes: fast / balanced / best
- No heavy processing in the browser

## Quick start
1) Load the extension:
   - Chrome -> Extensions -> Developer mode -> Load unpacked -> `extension/`
2) One-click installer (recommended):
   - Build or download `MangaUpscalerHostSetup.exe`
   - Run it after the extension is loaded
   - It auto-detects the extension ID, installs deps/models, and starts the tray host
   - Open `http://127.0.0.1:48159/health` and confirm `ok`
3) Manual host start (if needed):
   - `cd native_host`
   - `.\install_windows.ps1`
   - `run_host.bat` (tray) or `run_host.bat --console`
4) In the extension popup or settings:
   - Enable AI mode
   - Choose AI quality
   - Add your manga site to the whitelist

## Local AI host setup
Models belong in `native_host/models/`.

Recommended IllustrationJaNai files (color panels):
- `4x_IllustrationJaNai_V1_ESRGAN_135k.pth` (fast/balanced)
- `4x_IllustrationJaNai_V1_DAT2_190k.pth` (best)

MangaJaNai files (grayscale panels):
- Move all grayscale MangaJaNai `.pth` models into `native_host/models/`

Install deps:
```
cd native_host
.\install_windows.ps1
.\install_windows.ps1 -AllowDat2   # optional DAT2 models (slowest, highest quality)
```

## Notes
- The host uses `http://127.0.0.1:48159/enhance`.
- The venv, models, and cache are intentionally ignored by Git.
