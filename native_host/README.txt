Manga Upscaler — Optional AI / RTX Local Enhancer (Advanced)

Why this exists:
- Browser-only enhancement is fast and works everywhere, but it can't match true AI upscalers.
- This optional local host lets the extension send the current panel to a local program that can run
  Real-ESRGAN / waifu2x / RTX Video Super Resolution-like pipelines on your GPU.

What’s included here:
- native_messaging_manifest.template.json  (you MUST edit extension ID + path)
- install_windows.ps1  (writes the manifest + registry entry)
- host_server.py       (simple native host that accepts base64 PNG and returns enhanced PNG)

What is NOT included:
- AI models / binaries. You'll need to install an upscaler yourself (examples in host_server.py comments).

If you want me to wire this up fully for YOUR machine, tell me:
- Windows username
- Where you want it installed (e.g., C:\MangaUpscalerHost\)
- Which upscaler you prefer: Real-ESRGAN (recommended) or waifu2x
