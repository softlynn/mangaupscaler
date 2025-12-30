# Manga Upscaler Local Host installer (Windows)
# Run in PowerShell: .\install_windows.ps1 [-AllowDat2] [-SkipModelDownload] [-CudaIndexUrl <url>]

param(
  [switch]$AllowDat2,
  [switch]$SkipModelDownload,
  [switch]$SkipNativeMessaging,
  [switch]$NoPause,
  [string]$CudaIndexUrl = "https://download.pytorch.org/whl/cu121",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Write-Log {
  param([string]$Message)
  if (-not $LogPath) { return }
  try {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogPath -Value "[$ts] $Message"
  } catch {
    # ignore log errors
  }
}

function Resolve-Exec {
  param([string]$Name)
  try {
    return (Get-Command $Name -ErrorAction Stop).Source
  } catch {
    return $null
  }
}

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

if ($LogPath) {
  try { New-Item -ItemType File -Path $LogPath -Force | Out-Null } catch { }
}

function Write-LogLines {
  param([string[]]$Lines)
  if (-not $LogPath) { return }
  foreach ($line in $Lines) {
    if ($null -ne $line) {
      try { Add-Content -Path $LogPath -Value $line } catch { }
    }
  }
}

function Invoke-Logged {
  param(
    [string]$Label,
    [string]$Command,
    [string[]]$CmdArgs
  )
  Write-Log $Label
  Write-Log ("Command: " + $Command + " " + ($CmdArgs -join " "))
  try {
    $output = & $Command @CmdArgs 2>&1
  } catch {
    Write-Log ("Invoke failed: " + $_.Exception.Message)
    throw
  }
  if ($output) {
    Write-LogLines -Lines $output
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Log ("Exit code: " + $LASTEXITCODE)
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

$pyLauncher = Resolve-Exec -Name "py"
$pythonExe = Resolve-Exec -Name "python"
if (-not $pyLauncher -and -not $pythonExe) {
  Write-Host "Python not found. Install Python 3.10+ and rerun this installer."
  Write-Log "Python not found in PATH."
  exit 1
}

function New-Venv {
  param(
    [string]$Command,
    [string[]]$Args
  )
  try {
    $label = "Creating venv via $Command $($Args -join ' ')"
    Write-Log $label
    $output = & $Command @Args -m venv .venv 2>&1
    Write-LogLines -Lines $output
    if ($LASTEXITCODE -eq 0 -and (Test-Path ".venv\\Scripts\\python.exe")) {
      return $true
    }
  } catch {
    Write-Log ("Venv creation failed: " + $_.Exception.Message)
  }
  return $false
}

$venvPython = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"
$needsVenv = $true
if (Test-Path $venvPython) {
  try {
    $ver = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
  } catch {
    $ver = ""
  }
  if ($ver -eq "3.10" -or $ver -eq "3.11") {
    $needsVenv = $false
  } else {
    Write-Log "Existing venv uses Python $ver; recreating with 3.10/3.11."
    try { Remove-Item (Join-Path $PSScriptRoot ".venv") -Recurse -Force } catch { }
  }
}

if ($needsVenv) {
  $created = $false
  if ($pyLauncher) {
    $created = New-Venv -Command "py" -Args @("-3.10")
    if (-not $created) {
      $created = New-Venv -Command "py" -Args @("-3.11")
    }
  }
  if (-not $created -and $pythonExe) {
    $created = New-Venv -Command "python" -Args @()
  }
  if (-not $created) {
    Write-Host "Failed to create .venv. See install.log for details."
    exit 1
  }
}

if (-not (Test-Path $venvPython)) {
  Write-Host "Venv python not found. See install.log for details."
  Write-Log "Venv python missing at $venvPython"
  exit 1
}
Write-Log "Using venv python: $venvPython"

Write-Log "Installing Python dependencies."
Invoke-Logged -Label "pip upgrade" -Command $venvPython -CmdArgs @("-m","pip","install","--upgrade","pip")
Invoke-Logged -Label "pip requirements" -Command $venvPython -CmdArgs @("-m","pip","install","-r","requirements.txt")

# CUDA Torch build (adjust CudaIndexUrl if needed)
Write-Log "Installing Torch from $CudaIndexUrl"
Invoke-Logged -Label "pip torch cuda" -Command $venvPython -CmdArgs @("-m","pip","install","--force-reinstall","--index-url",$CudaIndexUrl,"torch","torchvision","torchaudio")
Invoke-Logged -Label "pip numpy" -Command $venvPython -CmdArgs @("-m","pip","install","numpy==2.2.6")

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
  Write-Log "Downloading MangaJaNai models."
  $dlArgs = @("host_server.py", "--download-models")
  if ($AllowDat2) { $dlArgs += "--allow-dat2" }
  & $venvPython @dlArgs
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Tray host: .\\run_host.bat (no console)"
Write-Host "Console host: .\\run_host.bat --console"
Write-Host "If Chrome is open, reload the extension."
if (-not $NoPause) {
  pause
}
