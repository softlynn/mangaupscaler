# Manga Upscaler Local Host installer (Windows)
# Run in PowerShell: .\install_windows.ps1 [-AllowDat2] [-SkipModelDownload] [-CudaIndexUrl <url>]

param(
  [switch]$AllowDat2,
  [switch]$SkipModelDownload,
  [switch]$DepsOnly,
  [switch]$TorchOnly,
  [switch]$ModelsOnly,
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

function Find-NvidiaSmi {
  $fromPath = Resolve-Exec -Name "nvidia-smi"
  if ($fromPath) { return $fromPath }

  $candidates = @(
    "C:\Windows\System32\nvidia-smi.exe",
    "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
    "C:\Program Files (x86)\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
  )
  if ($env:ProgramW6432) {
    $candidates += (Join-Path $env:ProgramW6432 "NVIDIA Corporation\NVSMI\nvidia-smi.exe")
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles "NVIDIA Corporation\NVSMI\nvidia-smi.exe")
  }
  if ($env:"ProgramFiles(x86)") {
    $candidates += (Join-Path $env:"ProgramFiles(x86)" "NVIDIA Corporation\NVSMI\nvidia-smi.exe")
  }
  $candidates += (Join-Path $env:WINDIR "System32\nvidia-smi.exe")

  foreach ($path in $candidates | Where-Object { $_ }) {
    if (Test-Path $path) { return $path }
  }

  $programDataRoot = Join-Path $env:ProgramData "NVIDIA Corporation\NVIDIA App\UpdateFramework\ota-artifacts\grd\post-processing"
  if (Test-Path $programDataRoot) {
    try {
      $found = Get-ChildItem -Path $programDataRoot -Recurse -Filter "nvidia-smi.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { return $found.FullName }
    } catch {
      # ignore search errors
    }
  }
  return $null
}

function Get-GpuComputeCapabilityFromWmi {
  try {
    $gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
  } catch {
    return $null
  }
  if (-not $gpu -or -not $gpu.Name) { return $null }
  Write-Log ("Detected GPU via WMI: " + $gpu.Name)
  if ($gpu.Name -match 'RTX 50\d{2}') {
    Write-Log "GPU name suggests RTX 50xx; assuming compute capability 12.0"
    return 12.0
  }
  return $null
}

function Get-GpuComputeCapability {
  $nvidiaSmi = Find-NvidiaSmi
  if (-not $nvidiaSmi) {
    Write-Log "nvidia-smi not found; attempting WMI GPU detection."
    $wmiCap = Get-GpuComputeCapabilityFromWmi
    if ($null -ne $wmiCap) { return $wmiCap }
    Write-Log "WMI fallback did not determine compute capability; using default CUDA index."
    return $null
  }
  Write-Log "Using nvidia-smi at $nvidiaSmi"
  try {
    $raw = & $nvidiaSmi --query-gpu=compute_cap --format=csv,noheader 2>$null
  } catch {
    $raw = $null
  }
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    $raw = $null
  }
  $caps = @()
  if ($raw) {
    foreach ($line in ($raw -split "`r?`n")) {
      $trim = $line.Trim()
      if (-not $trim) { continue }
      try {
        $caps += [double]::Parse($trim, [System.Globalization.CultureInfo]::InvariantCulture)
      } catch {
        continue
      }
    }
  }
  if ($caps.Count -eq 0) {
    Write-Log "Compute capability query returned no results; falling back to nvidia-smi -q."
    try {
      $q = & $nvidiaSmi -q 2>$null
      foreach ($line in ($q -split "`r?`n")) {
        if ($line -match 'Compute Capability\s*:\s*([0-9]+)\.([0-9]+)') {
          $caps += [double]::Parse(($Matches[1] + "." + $Matches[2]), [System.Globalization.CultureInfo]::InvariantCulture)
          break
        }
      }
    } catch {
      return $null
    }
  }
  if ($caps.Count -eq 0) { return $null }
  $maxCap = ($caps | Measure-Object -Maximum).Maximum
  Write-Log "Detected GPU compute capability: $maxCap"
  return $maxCap
}

function Write-TempRequirements {
  param([string]$SourcePath)
  $tmp = Join-Path $env:TEMP "mu_requirements.txt"
  $lines = @()
  foreach ($line in (Get-Content -Path $SourcePath -ErrorAction SilentlyContinue)) {
    if (-not $line) { continue }
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*(torch|torchvision|torchaudio)\b') { continue }
    $lines += $line
  }
  [System.IO.File]::WriteAllLines($tmp, $lines)
  return $tmp
}

function Write-TempPythonScript {
  param([string]$Name, [string]$Content)
  $tmp = Join-Path $env:TEMP $Name
  [System.IO.File]::WriteAllText($tmp, $Content)
  return $tmp
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
  try {
    if (-not (Test-Path $LogPath)) {
      New-Item -ItemType File -Path $LogPath -Force | Out-Null
    }
  } catch { }
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
  $prevErrorAction = $ErrorActionPreference
  $prevNative = $null
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Command @CmdArgs 2>&1
  } catch {
    Write-Log ("Invoke failed: " + $_.Exception.Message)
    $ErrorActionPreference = $prevErrorAction
    if ($null -ne $prevNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
    throw
  }
  $ErrorActionPreference = $prevErrorAction
  if ($null -ne $prevNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
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
    [string[]]$VenvArgs
  )
  try {
    $label = "Creating venv via $Command $($VenvArgs -join ' ')"
    Write-Log $label
    $output = & $Command @VenvArgs -m venv .venv 2>&1
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
    $created = New-Venv -Command "py" -VenvArgs @("-3.10")
    if (-not $created) {
      $created = New-Venv -Command "py" -VenvArgs @("-3.11")
    }
  }
  if (-not $created -and $pythonExe) {
    $created = New-Venv -Command "python" -VenvArgs @()
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

$phaseOnly = $DepsOnly -or $TorchOnly -or $ModelsOnly
$runDeps = $true
$runTorch = $true
$runModels = -not $SkipModelDownload
if ($phaseOnly) {
  $runDeps = $DepsOnly
  $runTorch = $TorchOnly
  $runModels = $ModelsOnly
}

if ($runDeps) {
  Write-Log "Phase: dependencies"
  Write-Host "Installing Python dependencies... (this can take several minutes)"
  Write-Log "Installing Python dependencies."
  Invoke-Logged -Label "pip upgrade" -Command $venvPython -CmdArgs @("-m","pip","install","--disable-pip-version-check","--upgrade","pip")
  Write-Log "Installing requirements (excluding torch packages)."
  $reqPath = Join-Path $PSScriptRoot "requirements.txt"
  $tmpReq = Write-TempRequirements -SourcePath $reqPath
  Invoke-Logged -Label "pip requirements" -Command $venvPython -CmdArgs @("-m","pip","install","--disable-pip-version-check","-r",$tmpReq)
  if ($tmpReq -and (Test-Path $tmpReq)) {
    try { Remove-Item $tmpReq -Force } catch { }
  }
}

# CUDA Torch build (adjust CudaIndexUrl if needed)
if ($runTorch) {
  Write-Log "Phase: torch"
  Write-Host "Installing PyTorch (CUDA)... (this can take several minutes)"
  $torchIndexUrl = $CudaIndexUrl
  $torchPre = $false
  $cap = $null
  if (-not $PSBoundParameters.ContainsKey("CudaIndexUrl")) {
    Write-Log "GPU preflight check"
    $cap = Get-GpuComputeCapability
    if ($null -ne $cap) {
      Write-Host ("Detected GPU compute capability: " + $cap)
    } else {
      Write-Host "Could not detect GPU compute capability; using default CUDA index."
    }
    if ($null -ne $cap -and $cap -ge 12.0) {
      $torchIndexUrl = "https://download.pytorch.org/whl/cu128"
      $torchPre = $false
      $msg = "Detected GPU compute capability $cap; using CUDA 12.8 build."
      Write-Host $msg
      Write-Log $msg
    }
  }
  Write-Log "Installing Torch from $torchIndexUrl"
  $torchArgs = @("-m","pip","install","--disable-pip-version-check","--force-reinstall","--index-url",$torchIndexUrl,"torch","torchvision","torchaudio")
  if ($torchPre) { $torchArgs = @("-m","pip","install","--disable-pip-version-check","--force-reinstall","--pre","--index-url",$torchIndexUrl,"torch","torchvision","torchaudio") }
  Invoke-Logged -Label "pip torch cuda" -Command $venvPython -CmdArgs $torchArgs
  Invoke-Logged -Label "pip numpy" -Command $venvPython -CmdArgs @("-m","pip","install","--disable-pip-version-check","numpy==2.2.6")

  $cudaCheckScript = @'
import json
import torch

info = {
    "torch_version": torch.__version__,
    "cuda_version": torch.version.cuda,
    "cuda_available": torch.cuda.is_available(),
}
if torch.cuda.is_available():
    info["device_name"] = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    info["device_capability"] = f"{cap[0]}.{cap[1]}"
    try:
        info["arch_list"] = torch.cuda.get_arch_list()
    except Exception as exc:
        info["arch_list_error"] = str(exc)
print(json.dumps(info))
'@
  $cudaCheckPath = Write-TempPythonScript -Name "mu_cuda_check.py" -Content $cudaCheckScript
  Write-Log "CUDA check"
  Write-Log ("Command: " + $venvPython + " " + $cudaCheckPath)
  $cudaOut = & $venvPython $cudaCheckPath 2>&1
  Write-LogLines -Lines $cudaOut
  try {
    $jsonLine = $cudaOut | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
    if ($jsonLine) {
      $info = $jsonLine | ConvertFrom-Json
      if ($info.cuda_available -and $info.device_capability -and $info.arch_list) {
        $capStr = ($info.device_capability -replace '\.','')
        $sm = "sm_$capStr"
        if ($info.arch_list -notcontains $sm) {
          $warn = "CUDA build does not include $sm; GPU acceleration may fail. Re-run installer with -CudaIndexUrl to a compatible build."
          Write-Host $warn
          Write-Log $warn
        }
      } elseif (-not $info.cuda_available) {
        $warn = "CUDA not available after install; using CPU (slow)."
        Write-Host $warn
        Write-Log $warn
      }
    }
  } catch {
    Write-Log ("CUDA check parse failed: " + $_.Exception.Message)
  }
  try { Remove-Item $cudaCheckPath -Force } catch { }
}

if ($phaseOnly) {
  Write-Log "Phase complete."
  if (-not $NoPause) {
    pause
  }
  exit 0
}

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
if ($runModels) {
  Write-Host "Downloading MangaJaNai models... (this can take a while)"
  Write-Log "Downloading MangaJaNai models."
  $dlArgs = @("host_server.py", "--download-models")
  if ($AllowDat2) { $dlArgs += "--allow-dat2" }
  Invoke-Logged -Label "model download" -Command $venvPython -CmdArgs $dlArgs
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Tray host: .\\run_host.bat (no console)"
Write-Host "Console host: .\\run_host.bat --console"
Write-Host "If Chrome is open, reload the extension."
if (-not $NoPause) {
  pause
}
