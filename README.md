# MangaUpscaler

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="MangaUpscaler icon" />
</p>

Chrome extension + local AI host for manga enhancement. The extension detects the
current panel in view and swaps it with an AI-upscaled version served by a local
host (Real-ESRGAN + MangaJaNai / IllustrationJaNai).

## Features
- Auto-detect grayscale vs color panels
- Auto-select MangaJaNai or IllustrationJaNai
- Model switching based on input height
- Quality modes: fast / balanced / best
- No heavy processing in the browser (AI runs locally)
- Tray app with logs + cache tools

## Download (Windows)
Get the latest **pre-release** assets:
- `MangaUpscalerHostSetup.exe` (one-click installer + tray host)
- `MangaUpscalerExtension.zip` (Chrome extension)

## Install (Windows, recommended)
1) Install the extension (unpacked):
   - Download and unzip `MangaUpscalerExtension.zip`
   - Chrome -> `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** -> select the unzipped folder (contains `manifest.json`)
   - Copy the **Extension ID** shown in Chrome (you’ll need it if auto-detect fails)

2) Install the local host:
   - Run `MangaUpscalerHostSetup.exe`
   - The installer tries to auto-detect the Extension ID; if it can’t, it will ask you to paste it
   - When finished, the tray app starts automatically

3) Verify:
   - Open `http://127.0.0.1:48159/health` (should return `ok`)
   - Optional: `http://127.0.0.1:48159/status` (shows whether the host is busy)

<p>
  <img src="native_host/installer/assets/wizard_small.png" width="48" alt="Installer icon" />
  <img src="native_host/installer/assets/wizard_image.png" width="220" alt="Installer wizard" />
</p>

## Use
1) Go to your manga site (or add it to the whitelist in Settings).
2) Open the extension popup:
   - **AI Mode** (recommended): uses the local AI host.
   - **Scale**: AI output scale (2×/3×/4×).
   - **AI Quality**: fast / balanced / best.
3) Click **Enhance** (or enable auto panel mode).

The tray icon shows a **green dot while enhancing**.

## Local AI host setup
Models belong in the host `models/` folder (installed to `%APPDATA%\\MangaUpscalerHost\\models`).

Recommended IllustrationJaNai files (color panels):
- `4x_IllustrationJaNai_V1_ESRGAN_135k.pth` (fast/balanced)
- `4x_IllustrationJaNai_V1_DAT2_190k.pth` (best)

MangaJaNai files (grayscale panels):
- Move all grayscale MangaJaNai `.pth` models into the `models/` folder

Install deps:
```
cd native_host
.\install_windows.ps1
.\install_windows.ps1 -AllowDat2   # optional DAT2 models (slowest, highest quality)
```

## Logs / troubleshooting
- Install log: `%APPDATA%\\MangaUpscalerHost\\install.log`
- Host log: `%APPDATA%\\MangaUpscalerHost\\host.log`
- If the site blocks loading `http://127.0.0.1:48159/...` directly, the extension automatically falls back to `blob:`/`data:` images.

## Notes
- The host uses `http://127.0.0.1:48159/enhance`.
- The venv, models, and cache are intentionally ignored by Git.
