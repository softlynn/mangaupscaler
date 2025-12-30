# Manga Upscaler Local Host installer (Windows)
# Run in PowerShell: .\install_windows.ps1 [-AllowDat2] [-SkipModelDownload] [-CudaIndexUrl <url>]

param(
  [switch]$AllowDat2,
  [switch]$SkipModelDownload,
  [switch]$SkipNativeMessaging,
  [string]$CudaIndexUrl = "https://download.pytorch.org/whl/cu121"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Resolve-PathString {
  param([string]$Path)
  if (-not $Path) { return $null }
  try {
    return ([System.IO.Path]::GetFullPath(($Path -replace '/', '\'))).TrimEnd('\')
  } catch {
    return $Path.TrimEnd('\')
  }
}

function Find-ExtensionId {
  param(
    [string]$ExtensionPath,
    [string]$NameHint
  )
  $extPath = Resolve-PathString $ExtensionPath
  $chromeRoot = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
  if (-not (Test-Path $chromeRoot)) { return $null }

  $profiles = Get-ChildItem -Path $chromeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "Default" -or $_.Name -like "Profile *" }

  $byName = $null
  foreach ($chromeProfile in $profiles) {
    foreach ($prefName in @("Preferences", "Secure Preferences")) {
      $prefPath = Join-Path $chromeProfile.FullName $prefName
      if (-not (Test-Path $prefPath)) { continue }
      try {
        $json = Get-Content $prefPath -Raw -ErrorAction Stop | ConvertFrom-Json
      } catch {
        continue
      }
      $settings = $json.extensions.settings
      if (-not $settings) { continue }
      foreach ($prop in $settings.PSObject.Properties) {
        $id = $prop.Name
        $entry = $prop.Value
        $p = $entry.path
        if ($p) {
          $pNorm = Resolve-PathString $p
          if ($extPath -and $pNorm -and $pNorm -ieq $extPath) {
            return $id
          }
        }
        if (-not $byName -and $entry.manifest -and $entry.manifest.name -eq $NameHint) {
          $byName = $id
        }
      }
    }
  }
  return $byName
}

if (-not (Test-Path ".venv")) {
  py -3.10 -m venv .venv
}

. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# CUDA Torch build (adjust CudaIndexUrl if needed)
python -m pip install --force-reinstall --index-url $CudaIndexUrl torch torchvision torchaudio
python -m pip install numpy==2.2.6

if (-not $SkipNativeMessaging) {
  # Register native messaging host for Chrome
  $extensionId = $null
  $extensionPath = Join-Path $PSScriptRoot "..\extension"
  if (Test-Path $extensionPath) {
    $extensionPath = (Resolve-Path $extensionPath).Path
  }
  $extensionId = Find-ExtensionId -ExtensionPath $extensionPath -NameHint "Manga Upscaler"
  if (-not $extensionId) {
    $defaultId = "kciacmbepigmndncggbcnlalmeokoknp"
    $inputId = Read-Host "Extension ID not auto-detected. Paste your unpacked extension ID (blank = default $defaultId)"
    if ($inputId) {
      $extensionId = $inputId.Trim()
    } else {
      $extensionId = $defaultId
    }
    Write-Host "Using extension ID: $extensionId"
    Write-Host "Load the unpacked extension once, then re-run this installer to auto-detect next time."
  } else {
    Write-Host "Detected extension ID: $extensionId"
  }
  $manifestPath = Join-Path $PSScriptRoot "native_messaging_manifest.json"
  $hostPath = Join-Path $PSScriptRoot "host_launcher.bat"
  $manifest = @{
    name = "com.softlynn.manga_upscaler"
    description = "Softlynn Manga Upscaler native host (optional AI mode)"
    path = $hostPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$extensionId/")
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

  $regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.softlynn.manga_upscaler"
  New-Item -Path $regPath -Force | Out-Null
  New-ItemProperty -Path $regPath -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null
}

# Optional model download (official MangaJaNai release)
if (-not $SkipModelDownload) {
  $dlArgs = @("host_server.py", "--download-models")
  if ($AllowDat2) { $dlArgs += "--allow-dat2" }
  python @dlArgs
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Tray host: .\\run_host.bat (no console)"
Write-Host "Console host: .\\run_host.bat --console"
Write-Host "If Chrome is open, reload the extension."
pause
