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

[Files]
Source: "..\\dist\\{#MyTrayExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\{#MyNativeExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "..\\dist\\host_server.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\install_windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\dist\\host_launcher.bat"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\\models"
Name: "{app}\\cache"

[Registry]
Root: HKCU; Subkey: "Software\\Google\\Chrome\\NativeMessagingHosts\\com.softlynn.manga_upscaler"; ValueType: string; ValueName: ""; ValueData: "{app}\\native_messaging_manifest.json"; Flags: uninsdeletekey

[Run]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\\install_windows.ps1"" -SkipNativeMessaging -NoPause -LogPath ""{app}\\install.log"""; Flags: waituntilterminated runhidden skipifsilent
Filename: "{app}\\{#MyTrayExe}"; Description: "Start Manga Upscaler Host tray"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /IM {#MyTrayExe} /T /F"; Flags: runhidden; RunOnceId: "KillTray"
Filename: "{cmd}"; Parameters: "/c taskkill /IM {#MyNativeExe} /T /F"; Flags: runhidden; RunOnceId: "KillNative"

[Code]
var
  ExtIdPage: TInputQueryWizardPage;
  DetectedExtensionId: string;
  DefaultExtensionId: string;

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
  DefaultExtensionId := 'kciacmbepigmndncggbcnlalmeokoknp';
  DetectedExtensionId := DetectExtensionId();
  ExtIdPage := CreateInputQueryPage(
    wpSelectDir,
    'Extension ID',
    'Paste your unpacked extension ID',
    'Leave blank to use default.'
  );
  ExtIdPage.Add('Extension ID:', False);
  ExtIdPage.Values[0] := DefaultExtensionId;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  if Assigned(ExtIdPage) and (PageID = ExtIdPage.ID) then begin
    Result := DetectedExtensionId <> '';
    if DetectedExtensionId <> '' then
      ExtIdPage.Values[0] := DetectedExtensionId;
  end else
    Result := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ManifestPath: string;
  Manifest: string;
  HostPath: string;
  ExtensionId: string;
begin
  if CurStep = ssPostInstall then begin
    ExtensionId := DetectedExtensionId;
    if ExtensionId = '' then begin
      ExtensionId := Trim(ExtIdPage.Values[0]);
      if ExtensionId = '' then
        ExtensionId := DefaultExtensionId;
    end;

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
  end;
end;
