Manga Upscaler - Local AI Host (Windows)

Why this exists:
- The extension relies on a local AI host for upscaling (MangaJaNai / IllustrationJaNai via Real-ESRGAN).
- The host runs locally so the browser stays lightweight.

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
- Most AI models are downloaded during install; some optional models may be hosted in project releases.

Notes:
- install_windows.ps1 attempts to auto-detect the unpacked extension ID from Chrome profiles.
- Optional: set `MU_ILLU_2X_URL` to override where the 2x IllustrationJaNai model downloads from.

Build the installer:
1) Run: .\build_exe.ps1
2) Open installer\MangaUpscalerHost.iss in Inno Setup and Compile.
3) Run MangaUpscalerHostSetup.exe after loading the unpacked extension.
