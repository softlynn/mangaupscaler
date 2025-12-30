# Build tray + native messaging host exes using PyInstaller
param(
  [string]$DistDir = "dist"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  py -3.10 -m venv .venv
}

. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install pyinstaller

$distPath = Join-Path $PSScriptRoot $DistDir

if (Test-Path "build_tray") { Remove-Item "build_tray" -Recurse -Force }
if (Test-Path "build_native") { Remove-Item "build_native" -Recurse -Force }

python -m PyInstaller --noconsole --onefile --name MangaUpscalerHost tray_app.py --distpath $distPath --workpath build_tray --specpath build_tray --clean
python -m PyInstaller --onefile --name MangaUpscalerNativeHost native_messaging_host.py --distpath $distPath --workpath build_native --specpath build_native --clean

Copy-Item (Join-Path $PSScriptRoot "config.json") $distPath -Force
Copy-Item (Join-Path $PSScriptRoot "host_server.py") $distPath -Force
Copy-Item (Join-Path $PSScriptRoot "install_windows.ps1") $distPath -Force
Copy-Item (Join-Path $PSScriptRoot "requirements.txt") $distPath -Force
Copy-Item (Join-Path $PSScriptRoot "host_launcher.bat") $distPath -Force
New-Item -ItemType Directory -Path (Join-Path $distPath "models") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distPath "cache") -Force | Out-Null

Write-Host ""
Write-Host "Build complete: $distPath"
