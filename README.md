# MangaUpscaler 📚✨

<p align="center">
  <img src="extension/icons/mangaupscaler.png" width="260" alt="MangaUpscaler" />
</p>

MangaUpscaler is a Chrome extension + local AI host for manga enhancement.
It detects the manga panel in view and swaps it with an AI-upscaled version from your PC (Real-ESRGAN + MangaJaNai / IllustrationJaNai).
#NOTE!! This was developed with help of codex 5.2 and for personal use, it is not guaranteed to work on every system, or every site. It has been tested with the following Nvidia GPUs:
- Nvidia RTX 5060 Ti 16gb

Plugin should work on most rtx nvidia gpus, but not guaranteed.
Chromium bases browsers are best, but firefox/brave may need some tweaking.

## ✨ Features
- 🎨 Auto-detect grayscale vs color panels
- 🤖 Auto-select MangaJaNai or IllustrationJaNai
- 📏 Model switching by input height
- ⚡ Quality modes: fast / balanced / best
- 🧠 No heavy browser processing (AI runs locally)
- 🖥️ Tray app with logs + cache tools (green dot while enhancing)

## ⬇️ Downloads (Windows)
- 🖥️ Host installer: [MangaUpscalerHostSetup.exe](https://github.com/softlynn/mangaupscaler/releases/download/v0.2.1-alpha/MangaUpscalerHostSetup.exe)
- 🧩 Chrome extension: [MangaUpscalerExtension.zip](https://github.com/softlynn/mangaupscaler/releases/download/v0.2.1-alpha/MangaUpscalerExtension.zip)

## 🧰 Install (Windows, recommended)
### 1) Add the extension (unpacked) 🧩
1. Download and unzip `MangaUpscalerExtension.zip`
2. In Chrome, open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder (contains `manifest.json`)
5. Copy your **Extension ID** (the installer will try to detect it, but you may need to paste it)

### 2) Install the local host 🖥️
1. Run `MangaUpscalerHostSetup.exe`
2. If auto-detect fails, paste your Extension ID when prompted
3. When finished, the tray app starts automatically ✅

### 3) ✅ Optional: verify
- `http://127.0.0.1:48159/health` → should return `ok`
- `http://127.0.0.1:48159/status` → shows whether the host is busy

## 🚀 Use
1. Go to your manga site (or add it to the whitelist in Settings).
2. Open the extension popup:
   - 🤖 **AI Mode** (recommended): uses the local AI host.
   - 🔍 **Scale**: AI output scale (2× / 3× / 4×).
   - ⚡ **AI Quality**: fast / balanced / best.
3. Click **Enhance panel** (or enable auto panel mode).
   - **Enhance + Preload** warms the next pages in the host cache (so scrolling feels faster).

## 🧩 Local host notes
- 📦 Models are installed to: `%APPDATA%\\MangaUpscalerHost\\models`
- 🎨 Recommended IllustrationJaNai (color):
  - ✅ `2x_IllustrationJaNai_V1_ESRGAN_120k.pth` (fast/balanced/best at 2x)
  - ✅ `4x_IllustrationJaNai_V1_ESRGAN_135k.pth` (fast/balanced)
  - 🐢 `4x_IllustrationJaNai_V1_DAT2_190k.pth` (best)
- 🖤 MangaJaNai (grayscale):
  - Move all grayscale MangaJaNai `.pth` models into the `models` folder

## 🧾 Logs / troubleshooting
- 📄 Install log: `%APPDATA%\\MangaUpscalerHost\\install.log`
- 📄 Host log: `%APPDATA%\\MangaUpscalerHost\\host.log`
- 🔒 If a site blocks loading `http://127.0.0.1:48159/...` directly, MangaUpscaler automatically falls back to `blob:` / `data:` images.

## ℹ️ Notes
- The host endpoint is `http://127.0.0.1:48159/enhance`.
- The venv, models, and cache are intentionally ignored by Git.
