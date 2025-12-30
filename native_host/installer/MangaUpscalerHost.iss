#define MyAppName "Manga Upscaler Host"
#define MyAppVersion "1.4.0"
#define MyAppPublisher "Softlynn"
#define MyTrayExe "MangaUpscalerHost.exe"
#define MyNativeExe "MangaUpscalerNativeHost.exe"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={userappdata}\MangaUpscalerHost
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=MangaUpscalerHostSetup
Compression=lzma
SolidCompression=yes
WizardImageFile=..\..\extension\icons\mangaupscaler.png
WizardSmallImageFile=..\..\extension\icons\mangaupscaler.png

[Files]
Source: "..\\dist\\{#MyTrayExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\{#MyNativeExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "..\\dist\\host_server.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\install_windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\host_launcher.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\tray_icon.png"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\\models"
Name: "{app}\\cache"

[Registry]
Root: HKCU; Subkey: "Software\\Google\\Chrome\\NativeMessagingHosts\\com.softlynn.manga_upscaler"; ValueType: string; ValueName: ""; ValueData: "{app}\\native_messaging_manifest.json"; Flags: uninsdeletekey

[Tasks]
Name: tailinstall; Description: "Open live install log during installation (PowerShell)"; Flags: unchecked
Name: tailhost; Description: "Open live host log during installation (PowerShell)"; Flags: unchecked

[Run]
Filename: "{sysnative}\\WindowsPowerShell\\v1.0\\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\\install_windows.ps1"" -SkipNativeMessaging -DepsOnly -NoPause -LogPath ""{app}\\install.log"""; StatusMsg: "Phase 1/3: Installing Python dependencies..."; Flags: waituntilterminated runhidden skipifsilent
Filename: "{sysnative}\\WindowsPowerShell\\v1.0\\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\\install_windows.ps1"" -SkipNativeMessaging -TorchOnly -NoPause -LogPath ""{app}\\install.log"""; StatusMsg: "Phase 2/3: Installing PyTorch (CUDA)..."; Flags: waituntilterminated runhidden skipifsilent
Filename: "{sysnative}\\WindowsPowerShell\\v1.0\\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\\install_windows.ps1"" -SkipNativeMessaging -ModelsOnly -NoPause -LogPath ""{app}\\install.log"""; StatusMsg: "Phase 3/3: Downloading MangaJaNai models..."; Flags: waituntilterminated runhidden skipifsilent
Filename: "{app}\\{#MyTrayExe}"; Description: "Start Manga Upscaler Host tray"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /IM {#MyTrayExe} /T /F"; Flags: runhidden; RunOnceId: "KillTray"
Filename: "{cmd}"; Parameters: "/c taskkill /IM {#MyNativeExe} /T /F"; Flags: runhidden; RunOnceId: "KillNative"

[Code]
var
  ExtIdPage: TInputQueryWizardPage;
  DetectedExtensionId: string;
  DefaultExtensionId: string;
  InstallLogPath: string;

function DetectExtensionId(): string;
var
  TmpFile: string;
  PsCmd: string;
  Args: string;
  ResultCode: Integer;
  Id: AnsiString;
begin
  Result := '';
  TmpFile := ExpandConstant('{tmp}\mu_extid.txt');
  if FileExists(TmpFile) then
    DeleteFile(TmpFile);

  PsCmd :=
    '$ErrorActionPreference="SilentlyContinue";' +
    '$root = Join-Path $env:LOCALAPPDATA ''Google\Chrome\User Data'';' +
    '$id = $null;' +
    'if (Test-Path $root) {' +
    ' $profiles = Get-ChildItem -Path $root -Directory | Where-Object { $_.Name -eq ''Default'' -or $_.Name -like ''Profile *'' };' +
    ' foreach ($p in $profiles) {' +
    '  foreach ($pref in @(''Preferences'',''Secure Preferences'')) {' +
    '   $prefPath = Join-Path $p.FullName $pref;' +
    '   if (-not (Test-Path $prefPath)) { continue };' +
    '   try { $json = Get-Content $prefPath -Raw | ConvertFrom-Json } catch { continue };' +
    '   $settings = $json.extensions.settings;' +
    '   if (-not $settings) { continue };' +
    '   foreach ($prop in $settings.PSObject.Properties) {' +
    '     $entry = $prop.Value;' +
    '     if ($entry.manifest -and $entry.manifest.name -eq ''Manga Upscaler'') { $id = $prop.Name; break }' +
    '   }' +
    '   if ($id) { break }' +
    '  }' +
    '  if ($id) { break }' +
    ' }' +
    '}' +
    'if ($id) { Set-Content -Path ''' + TmpFile + ''' -Value $id }';

  Args := '-NoProfile -ExecutionPolicy Bypass -Command "' + PsCmd + '"';
  Exec('powershell.exe', Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if LoadStringFromFile(TmpFile, Id) then
    Result := Trim(String(Id));
end;

procedure InitializeWizard();
begin
  DefaultExtensionId := '';
  DetectedExtensionId := DetectExtensionId();
  ExtIdPage := CreateInputQueryPage(
    wpWelcome,
    'Extension ID',
    'Paste your unpacked extension ID',
    'Open chrome://extensions, enable Developer mode, then copy the ID.'
  );
  ExtIdPage.Add('Extension ID:', False);
  if DetectedExtensionId <> '' then
    ExtIdPage.Values[0] := DetectedExtensionId
  else
    ExtIdPage.Values[0] := '';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if Assigned(ExtIdPage) and (CurPageID = ExtIdPage.ID) then begin
    if Trim(ExtIdPage.Values[0]) = '' then begin
      MsgBox(
        'Extension ID is required.' + #13#10 + #13#10 +
        'In Chrome:' + #13#10 +
        '1) Go to chrome://extensions' + #13#10 +
        '2) Enable Developer mode' + #13#10 +
        '3) Load the unpacked Manga Upscaler extension' + #13#10 +
        '4) Copy the ID and paste it here',
        mbError, MB_OK
      );
      Result := False;
    end;
  end;
end;

procedure StartLogTail(const LogPath, Title: string);
var
  PsCmd: string;
  Args: string;
  ResultCode: Integer;
begin
  PsCmd :=
    '$p=''' + LogPath + ''';' +
    'Write-Host ''--- ' + Title + ' ---'';' +
    'Write-Host ''Tailing: '' $p;' +
    'while(-not (Test-Path $p)) { Start-Sleep -Milliseconds 250 };' +
    'Get-Content -Path $p -Wait -Tail 60';
  Args := '-NoProfile -NoExit -Command "' + PsCmd + '"';
  Exec('powershell.exe', Args, '', SW_SHOWNORMAL, ewNoWait, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ManifestPath: string;
  Manifest: string;
  HostPath: string;
  ExtensionId: string;
  HostLogPath: string;
begin
  if CurStep = ssInstall then begin
    InstallLogPath := ExpandConstant('{app}\install.log');
    ForceDirectories(ExtractFileDir(InstallLogPath));
    SaveStringToFile(InstallLogPath,
      GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' [InnoSetup] Installer started' + #13#10,
      True);

    HostLogPath := ExpandConstant('{app}\host.log');
    if WizardIsTaskSelected('tailinstall') then
      StartLogTail(InstallLogPath, 'Install log');
    if WizardIsTaskSelected('tailhost') then
      StartLogTail(HostLogPath, 'Host log');
  end;

  if CurStep = ssPostInstall then begin
    ExtensionId := Trim(ExtIdPage.Values[0]);

    ManifestPath := ExpandConstant('{app}\native_messaging_manifest.json');
    HostPath := ExpandConstant('{app}\{#MyNativeExe}');
    StringChange(HostPath, '\', '\\');
    Manifest :=
      '{' + #13#10 +
      '  "name": "com.softlynn.manga_upscaler",' + #13#10 +
      '  "description": "Softlynn Manga Upscaler native host (optional AI mode)",' + #13#10 +
      '  "path": "' + HostPath + '",' + #13#10 +
      '  "type": "stdio",' + #13#10 +
      '  "allowed_origins": ["chrome-extension://' + ExtensionId + '/"]' + #13#10 +
      '}' + #13#10;
    SaveStringToFile(ManifestPath, Manifest, False);

    if InstallLogPath <> '' then
      SaveStringToFile(InstallLogPath,
        GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' [InnoSetup] native_messaging_manifest.json written' + #13#10,
        True);
  end;
end;
