# Manga Upscaler Local Host installer (Windows)
# Run in PowerShell:  .\install_windows.ps1
$ErrorActionPreference = "Stop"
cd $PSScriptRoot

if (-not (Test-Path ".venv")) {
  py -3.10 -m venv .venv
}

. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install pillow numpy requests realesrgan basicsr

python -m pip install --force-reinstall --index-url https://download.pytorch.org/whl/cu121 torch torchvision
python -m pip install numpy==2.2.6

Write-Host ""
Write-Host "CUDA Torch installed (cu121). If this fails, install manually from https://pytorch.org/get-started/locally/"
Write-Host "Then run:"
Write-Host "  .\run_host.bat"
pause
