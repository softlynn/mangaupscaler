Manga Upscaler - Optional AI / RTX Local Enhancer (Advanced)

Why this exists:
- Browser-only enhancement is fast and works everywhere, but it can't match true AI upscalers.
- This optional local host lets the extension send the current panel to a local program that can run
  Real-ESRGAN / waifu2x / RTX Video Super Resolution-like pipelines on your GPU.

What's included here:
- native_messaging_manifest.template.json  (template for native messaging registration)
- install_windows.ps1  (installs deps + registers native messaging + optional model download)
- host_launcher.bat    (native messaging entrypoint)
- native_messaging_host.py  (starts the tray host on demand)
- tray_app.py          (system tray host with start/stop + cache tools)
- host_server.py       (local HTTP host that returns enhanced PNGs)
- build_exe.ps1        (builds tray/native host exes with PyInstaller)
- installer/           (Inno Setup script for a packaged installer)

What is NOT included:
- AI models. Install via install_windows.ps1 or the Settings "Download models" button.

Notes:
- install_windows.ps1 attempts to auto-detect the unpacked extension ID from Chrome profiles.

Build the installer:
1) Run: .\build_exe.ps1
2) Open installer\MangaUpscalerHost.iss in Inno Setup and Compile.
3) If your extension ID differs, update it in the .iss before building.
