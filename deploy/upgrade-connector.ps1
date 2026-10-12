param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$Version,
    [ValidateSet('en','zh-CN')][string]$Language,
    [switch]$QaFailAfterCopy,
    [switch]$QaAbortAfterMove,
    [switch]$QaAbortCommitted,
    [switch]$QaFailAfterLanguage,
    [switch]$QaAbortAfterLanguage,
    [switch]$QaAbortAfterQuit,
    [switch]$Repair,
    [switch]$Recover
)
$ErrorActionPreference = 'Stop'
# Installed upgrade/recovery always resumes the saved runtime identity and permissions.
# Developer CLI bootstrap remains free to use these overrides outside this helper.
foreach ($name in @('CODEX_THREAD_ID','BRIDGE_ENABLE_SEND','BRIDGE_SEND_THREAD_ID','BRIDGE_SEND_SCOPE','BRIDGE_PORT')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$Stage = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
$default = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexMobileConnector')).TrimEnd('\')
if (($QaFailAfterCopy -or $QaAbortAfterMove -or $QaAbortCommitted -or $QaFailAfterLanguage -or $QaAbortAfterLanguage -or $QaAbortAfterQuit) -and $Root -ieq $default) { throw 'QA failure injection is forbidden for the default installation.' }
if (-not (Test-Path -LiteralPath $Root -PathType Container) -or -not (Test-Path -LiteralPath $Stage -PathType Container)) { throw 'Installation or staged package is missing.' }
if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root cannot be a link.' }
$localPath = Join-Path $Root '.local'
if ((Test-Path -LiteralPath $localPath) -and ((Get-Item -LiteralPath $localPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Local data directory cannot be a link.' }
$journalPath = $Root + '.upgrade-journal.json'
$journalPrevious = $journalPath + '.previous'
$backup = $Root + '.upgrade-backup'
function File-Sha256([string]$Path) {
    $stream=[IO.File]::OpenRead($Path); $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function No-Links([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths cannot contain links. Keep local data and use the original ordinary directory.' }
        $parent = [IO.Path]::GetDirectoryName($cursor); if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
foreach ($path in @($Root,$Stage,$journalPath,$journalPrevious,$journalPath+'.tmp',$backup)) { No-Links $path }
if ($Stage.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase) -or $Root.StartsWith($Stage+'\',[StringComparison]::OrdinalIgnoreCase) -or $Root -ieq $Stage) { throw 'Staged package and installation must be separate directories.' }
foreach ($path in @($Root,$Stage)) {
    foreach ($item in Get-ChildItem -LiteralPath $path -Recurse -Force) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation or staged package contains a link; repair/upgrade was stopped.' } }
}
if (Test-Path -LiteralPath (Join-Path $Stage '.local')) { throw 'Staged package contains local data.' }
function Owned-Version([string]$MarkerPath, [string[]]$Bases) {
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { throw 'Installation ownership cannot be verified. Keep .local and use the original installation directory.' }
    try { $marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json } catch { throw 'Installation ownership record is damaged. Keep .local; do not overwrite an unknown directory.' }
    if ($marker.version -isnot [int] -or $marker.version -ne 1 -or $marker.root -isnot [string] -or [IO.Path]::GetFullPath($marker.root).TrimEnd('\') -ine $Root -or ($marker.PSObject.Properties['application'] -and $marker.application -cne 'codex-mobile-bridge')) { throw 'Installation ownership cannot be verified. Keep .local and use the original installation directory.' }
    function Evidence-File([string]$Name) { foreach ($base in $Bases) { $candidate=Join-Path $base $Name; if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }; return $null }
    $executable = Evidence-File 'CodexMobileConnector.exe'
    if ($executable) {
        $assembly=$null
        try { $assembly=[Reflection.AssemblyName]::GetAssemblyName($executable) } catch {
            $product=[Diagnostics.FileVersionInfo]::GetVersionInfo($executable).ProductName
            if ($product -and $product -cne 'Codex Mobile Bridge') { throw 'Installed executable belongs to another application; repair was stopped.' }
        }
        if ($assembly) {
            $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
            if ($assembly.Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector') -or ($info.ProductName -and $info.ProductName -cne 'Codex Mobile Bridge')) { throw 'Installed executable belongs to another application; repair was stopped.' }
            try { $executableVersion=[version]$info.ProductVersion } catch { throw 'Installed application version is invalid. Keep local data and verify ownership before repair.' }
            if (-not $info.ProductName) {
                Add-Type -AssemblyName System.Web.Extensions
                $package=Get-Content -LiteralPath (Evidence-File 'package.json') -Raw | ConvertFrom-Json
                $lock=(New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText((Evidence-File 'package-lock.json')))
                if ($package.name -cne 'codex-mobile-bridge' -or $lock.name -cne $package.name -or $lock.version -cne $package.version -or [version]$package.version -ne $executableVersion) { throw 'Legacy executable identity/version evidence is inconsistent; upgrade was stopped.' }
            }
            return $executableVersion
        }
    }
    if ($marker.application -ceq 'codex-mobile-bridge' -and $marker.appVersion -is [string]) {
        try { return [version]$marker.appVersion } catch { throw 'Installed application version record is invalid. Keep local data and verify ownership before repair.' }
    }
    # Published legacy markers identify only the root. Corroborate damaged/missing
    # EXE ownership with independent bundled product/version files, never marker alone.
    try {
        $package=Get-Content -LiteralPath (Evidence-File 'package.json') -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Web.Extensions
        $lock=(New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText((Evidence-File 'package-lock.json')))
        $source=Get-Content -LiteralPath (Evidence-File 'deploy/windows/Connector.cs') -Raw
        if ($package.name -cne 'codex-mobile-bridge' -or $lock.name -cne $package.name -or $lock.version -cne $package.version -or $package.version -isnot [string] -or -not $source.Contains('[assembly: AssemblyProduct("Codex Mobile Bridge")]')) { throw 'Invalid product evidence' }
        return [version]$package.version
    } catch { throw 'Damaged installation ownership/version cannot be verified. Keep .local; restore the original product files or contact support before repair.' }
}
try { $incoming=[version]$Version } catch { throw 'Incoming application version is invalid.' }
$newExe=Join-Path $Stage 'CodexMobileConnector.exe'
if (-not (Test-Path -LiteralPath $newExe -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Stage 'runtime/node.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Stage 'scripts/connector-gui.mjs') -PathType Leaf)) { throw 'Staged package is incomplete.' }
if ([Reflection.AssemblyName]::GetAssemblyName($newExe).Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector') -or [Diagnostics.FileVersionInfo]::GetVersionInfo($newExe).ProductName -cne 'Codex Mobile Bridge' -or [version]([Diagnostics.FileVersionInfo]::GetVersionInfo($newExe).ProductVersion) -ne $incoming) { throw 'Staged application identity/version does not match setup.' }
function Safe-TopLevelName([string]$Name) {
    return $Name -and $Name -notin @('.','..','.local') -and $Name -notmatch '[<>:"/\\|?*\x00-\x1f]' -and $Name.TrimEnd(' ','.') -ceq $Name -and -not [IO.Path]::IsPathRooted($Name)
}
if ($Recover) {
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { throw 'Interrupted upgrade journal is missing.' }
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    if ($journal.version -ne 1 -or $journal.root -ine $Root -or $journal.backup -ine $backup -or $journal.phase -notin @('inProgress','committed')) { throw 'Interrupted upgrade journal is invalid.' }
    if ($journal.originalNames -isnot [array] -or $journal.stagedNames -isnot [array] -or $journal.originalNames.Count -gt 100 -or $journal.stagedNames.Count -gt 100) { throw 'Interrupted upgrade journal file list is invalid.' }
    foreach ($name in @($journal.originalNames)+@($journal.stagedNames)) { if (-not (Safe-TopLevelName $name)) { throw 'Interrupted upgrade journal contains an invalid path.' } }
    $expectedStageNames = @(Get-ChildItem -LiteralPath $Stage -Force | ForEach-Object Name) + @('installed.json')
    if ($expectedStageNames.Count -ne $journal.stagedNames.Count -or @(Compare-Object $expectedStageNames $journal.stagedNames).Count -ne 0) { throw 'Interrupted upgrade journal does not match this setup package.' }
    if ((Test-Path -LiteralPath $backup) -and (-not (Test-Path -LiteralPath $backup -PathType Container) -or ((Get-Item -LiteralPath $backup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'Interrupted upgrade backup is invalid or linked.' }
    if (Test-Path -LiteralPath $backup) {
        foreach ($item in Get-ChildItem -LiteralPath $backup -Force) { if (-not (Safe-TopLevelName $item.Name) -or $item.Name -notin $journal.originalNames -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Interrupted upgrade backup contains an unexpected item.' } }
        foreach ($item in Get-ChildItem -LiteralPath $backup -Recurse -Force) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Interrupted upgrade backup is linked; backup was retained.' } }
    }
    if ($journal.originalExecutableHash) {
        if ($journal.originalExecutableHash -notmatch '^[0-9a-f]{64}$') { throw 'Interrupted upgrade executable integrity record is invalid.' }
        $originalExe=Join-Path $backup 'CodexMobileConnector.exe'
        if (-not (Test-Path -LiteralPath $originalExe) -and $journal.phase -eq 'inProgress') { $originalExe=Join-Path $Root 'CodexMobileConnector.exe' }
        if (Test-Path -LiteralPath $originalExe) {
            if ((File-Sha256 $originalExe) -cne $journal.originalExecutableHash) { throw 'Interrupted upgrade original executable changed; backup was retained.' }
        } elseif ($journal.phase -eq 'inProgress') { throw 'Interrupted upgrade original executable is missing; backup was retained.' }
    }
    if ($journal.phase -eq 'committed') {
        $installedVersion = Owned-Version (Join-Path $Root 'installed.json') @($Root)
        $committedExe=Join-Path $Root 'CodexMobileConnector.exe'
        if ($installedVersion -ne $incoming -or -not (Test-Path -LiteralPath $committedExe -PathType Leaf) -or [Reflection.AssemblyName]::GetAssemblyName($committedExe).Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector') -or [Diagnostics.FileVersionInfo]::GetVersionInfo($committedExe).ProductName -cne 'Codex Mobile Bridge') { throw 'Committed installation ownership/version cannot be verified; backup was retained.' }
        if (Test-Path -LiteralPath $backup) {
            foreach ($item in Get-ChildItem -LiteralPath $backup -Force) {
                if (-not (Safe-TopLevelName $item.Name) -or $item.Name -notin $journal.originalNames -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Interrupted upgrade backup contains an unexpected item.' }
            }
            $backupMarker=Join-Path $backup 'installed.json'; $backupExe=Join-Path $backup 'CodexMobileConnector.exe'
            if (Test-Path -LiteralPath $backupMarker) {
                $saved=Get-Content -LiteralPath $backupMarker -Raw | ConvertFrom-Json
                if ($saved.version -isnot [int] -or $saved.version -ne 1 -or $saved.root -isnot [string] -or [IO.Path]::GetFullPath($saved.root).TrimEnd('\') -ine $Root -or ($saved.PSObject.Properties['application'] -and $saved.application -cne 'codex-mobile-bridge')) { throw 'Interrupted upgrade backup ownership is invalid; backup was retained.' }
            }
            if (Test-Path -LiteralPath $backupExe) {
                if ($journal.originalExecutableHash) {
                    if ($journal.originalExecutableHash -notmatch '^[0-9a-f]{64}$' -or (File-Sha256 $backupExe) -cne $journal.originalExecutableHash) { throw 'Interrupted upgrade backup executable changed; backup was retained.' }
                } elseif ([Reflection.AssemblyName]::GetAssemblyName($backupExe).Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector') -or [Diagnostics.FileVersionInfo]::GetVersionInfo($backupExe).ProductName -cne 'Codex Mobile Bridge') { throw 'Interrupted upgrade backup executable belongs to another app; backup was retained.' }
            }
            # A prior committed cleanup may already have deleted some old evidence.
            # The verified installed product plus exact original-name allowlist lets
            # cleanup finish, while unrelated extra items are always preserved.
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
        Remove-Item -LiteralPath $journalPath -Force
        Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue
        return
    }
    if (-not (Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }
    if (-not (Test-Path -LiteralPath $backup -PathType Container) -or ((Get-Item -LiteralPath $backup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Interrupted upgrade backup is invalid or linked.' }
    $savedMarker = if (Test-Path -LiteralPath (Join-Path $backup 'installed.json')) { Join-Path $backup 'installed.json' } else { Join-Path $Root 'installed.json' }
    $savedExe = if (Test-Path -LiteralPath (Join-Path $backup 'CodexMobileConnector.exe')) { Join-Path $backup 'CodexMobileConnector.exe' } else { Join-Path $Root 'CodexMobileConnector.exe' }
    $savedVersion = Owned-Version $savedMarker @($backup,$Root)
    $nodePath = Join-Path $Root 'runtime/node.exe'; $guiPath = Join-Path $Root 'CodexMobileConnector.exe'
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $guiPath -or ($_.ExecutablePath -ieq $nodePath -and $_.CommandLine -match ([regex]::Escape($Root) + '[\\/](?:scripts|src)[\\/]')) })
        if ($running.Count -eq 0) { break }
        foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        Start-Sleep -Milliseconds 150
    }
    if ($running.Count -ne 0) { throw 'Interrupted upgrade processes could not be stopped.' }
    foreach ($name in $journal.stagedNames) {
        $target = Join-Path $Root $name
        if ((Test-Path -LiteralPath (Join-Path $backup $name)) -or $name -notin $journal.originalNames) { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force } }
    }
    foreach ($item in Get-ChildItem -LiteralPath $backup -Force) {
        if (-not (Safe-TopLevelName $item.Name) -or $item.Name -notin $journal.originalNames -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Interrupted upgrade backup contains an unexpected item.' }
        Move-Item -LiteralPath $item.FullName -Destination $Root -Force
    }
    $controlPath = Join-Path $Root '.local/connector-control.json'
    if ($journal.hadControl) { [IO.File]::WriteAllBytes($controlPath,[Convert]::FromBase64String($journal.controlBase64)) }
    elseif (Test-Path -LiteralPath $controlPath) { Remove-Item -LiteralPath $controlPath -Force }
    $languagePath = Join-Path $Root '.local/desktop-language.json'
    if ($journal.PSObject.Properties['hadLanguage']) {
        if ($journal.hadLanguage) { [IO.File]::WriteAllBytes($languagePath,[Convert]::FromBase64String($journal.languageBase64)) }
        elseif (Test-Path -LiteralPath $languagePath) { Remove-Item -LiteralPath $languagePath -Force }
    }
    if ($journal.wasBridge -and -not $journal.repair) { & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/start.mjs') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Previous bridge could not be restarted.' } }
    if ($journal.wasActive -and -not $journal.repair) {
        $resumed = '{"action":"connect","reason":"manual"}' | & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/connector-gui.mjs') | ConvertFrom-Json
        if (-not $resumed.ok -or -not $resumed.recoveryCompleted) { throw 'Previous connection could not be resumed.' }
    }
    if ($journal.wasGui -and -not $journal.repair) { Start-Process -FilePath (Join-Path $Root 'CodexMobileConnector.exe') -ArgumentList @('--install-root',('"'+$Root+'"'),'--tray') -WindowStyle Hidden }
    Remove-Item -LiteralPath $backup -Recurse -Force
    Remove-Item -LiteralPath $journalPath -Force
    Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue
    if ($journal.repair) { $recoveryIntent=$journal; $Repair=$true } else { return }
}
if (Test-Path -LiteralPath $journalPath) { throw 'Interrupted upgrade must be recovered before starting another.' }
if (Test-Path -LiteralPath $backup) { throw 'Upgrade backup path is already occupied.' }
$markerPath = Join-Path $Root 'installed.json'
$oldExe = Join-Path $Root 'CodexMobileConnector.exe'
$oldNode = Join-Path $Root 'runtime/node.exe'
$oldGui = Join-Path $Root 'scripts/connector-gui.mjs'
$current = Owned-Version $markerPath @($Root)
if ($current -gt $incoming) { throw "Installed version $current is newer than $Version. Use the same or a newer setup; downgrade is refused." }
if ($current -eq $incoming -and -not $Repair) { throw "Installed version $current is not older than $Version. Run setup and choose Repair." }
$controlPath = Join-Path $Root '.local/connector-control.json'
$hadControl = Test-Path -LiteralPath $controlPath -PathType Leaf
$controlBytes = if ($hadControl) { [IO.File]::ReadAllBytes($controlPath) } else { $null }
$languagePath = Join-Path $Root '.local/desktop-language.json'
$hadLanguage = Test-Path -LiteralPath $languagePath -PathType Leaf
$languageBytes = if ($hadLanguage) { [IO.File]::ReadAllBytes($languagePath) } else { $null }
try { $intent = if ($hadControl) { Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json } else { $null } } catch { throw 'Saved connection intent is damaged; repair/upgrade was stopped. Keep .local and resolve the damaged settings before retrying.' }
if ($intent -and ($intent.paused -isnot [bool] -or $intent.autoStart -isnot [bool])) { throw 'Saved connection intent is damaged; upgrade was stopped.' }
$paired = Test-Path -LiteralPath (Join-Path $Root '.local/hub-connector.json') -PathType Leaf
$entries = @('scripts/connector-login.mjs','scripts/start-connector.mjs','scripts/start.mjs','scripts/supervisor.mjs','scripts/collaboration-mcp.mjs','src/server.mjs')
function Owned-Processes([string[]]$Scripts, [bool]$IncludeGui) {
    @(
        foreach ($process in Get-CimInstance Win32_Process) {
            if ($process.ProcessId -eq $PID -or -not $process.ExecutablePath) { continue }
            $owned = $IncludeGui -and $process.ExecutablePath -ieq $oldExe
            if ($process.ExecutablePath -ieq $oldNode -and $process.CommandLine) {
                foreach ($entry in $Scripts) {
                    $script = Join-Path $Root $entry
                    if ($process.CommandLine -match ('(?i)(?:^|\s)"'+[regex]::Escape($script)+'"(?:\s|$)') -or $process.CommandLine -match ('(?i)(?:^|\s)'+[regex]::Escape($script)+'(?:\s|$)')) { $owned = $true; break }
                }
            }
            if ($owned) { $process }
        }
    )
}
function Stop-Owned([string[]]$Scripts, [bool]$IncludeGui) {
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        $owned = @(Owned-Processes $Scripts $IncludeGui)
        if ($owned.Count -eq 0) { return }
        foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        Start-Sleep -Milliseconds 150
    }
    if (@(Owned-Processes $Scripts $IncludeGui).Count -ne 0) { throw 'Owned installation processes could not be stopped.' }
}
$before = @(Owned-Processes $entries $true)
$wasGui = @($before | Where-Object { $_.ExecutablePath -ieq $oldExe }).Count -gt 0
$wasActive = $paired -and $intent -and -not $intent.paused -and (@($before | Where-Object { $_.CommandLine -match 'connector-login\.mjs|start-connector\.mjs' }).Count -gt 0 -or $recoveryIntent.wasActive)
$wasBridge = @($before | Where-Object { $_.CommandLine -match 'src[\\/]server\.mjs' }).Count -gt 0 -or $recoveryIntent.wasBridge
$wasGui = $wasGui -or $recoveryIntent.wasGui
$moved = New-Object System.Collections.Generic.List[string]
$copied = New-Object System.Collections.Generic.List[string]
$committed = $false
$rolledBack = $false
$journal = @{ version=1; root=$Root; backup=$backup; phase='inProgress'; repair=[bool]$Repair; originalExecutableHash=if(Test-Path -LiteralPath $oldExe -PathType Leaf){File-Sha256 $oldExe}else{$null}; originalNames=@(Get-ChildItem -LiteralPath $Root -Force | Where-Object Name -ne '.local' | ForEach-Object Name); stagedNames=@(Get-ChildItem -LiteralPath $Stage -Force | ForEach-Object Name)+@('installed.json'); hadControl=$hadControl; controlBase64=if($hadControl){[Convert]::ToBase64String($controlBytes)}else{$null}; hadLanguage=$hadLanguage; languageBase64=if($hadLanguage){[Convert]::ToBase64String($languageBytes)}else{$null}; wasActive=[bool]$wasActive; wasBridge=[bool]$wasBridge; wasGui=[bool]$wasGui }
$journalTemp = $journalPath + '.tmp'
[IO.File]::WriteAllText($journalTemp,($journal | ConvertTo-Json -Depth 5 -Compress),(New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $journalTemp -Destination $journalPath -ErrorAction Stop
New-Item -ItemType Directory -Path $backup | Out-Null
try {
    if ($wasActive) {
        $stopNode = Join-Path $Stage 'runtime/node.exe'; $stopGui = Join-Path $Stage 'scripts/connector-gui.mjs'
        # argv[1] must not equal the imported module, or its stdin CLI also runs.
        $stopSource = "import{pathToFileURL}from'node:url';const url=pathToFileURL(process.argv[2]);const{guiCommand}=await import(url);const{createConnectorControl,stopOwnedConnectorProcesses}=await import(new URL('connector-control.mjs',url));const root=process.argv[3];const control=createConnectorControl({root,stop:()=>stopOwnedConnectorProcesses({root,nodePath:process.argv[4]})});console.log(JSON.stringify({ok:true,...await guiCommand({action:'quit'},{root,control})}));"
        $request = & $stopNode --input-type=module -e $stopSource repair-stop $stopGui $Root $oldNode | ConvertFrom-Json
        if (-not $request.ok -or -not $request.disconnectVerified) { throw 'Old connector did not confirm a clean stop.' }
        if ($hadControl) { [IO.File]::WriteAllBytes($controlPath,$controlBytes) }
        if ($QaAbortAfterQuit) { [Environment]::Exit(94) }
    }
    Stop-Owned @('scripts/connector-login.mjs','scripts/start.mjs','scripts/supervisor.mjs') $false
    Stop-Owned @('scripts/start-connector.mjs','scripts/collaboration-mcp.mjs','src/server.mjs') $true
    if (@(Owned-Processes $entries $true).Count -ne 0) { throw 'Installation processes are still running.' }
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        if ($item.Name -eq '.local') { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation contains a link; upgrade was stopped.' }
        Move-Item -LiteralPath $item.FullName -Destination $backup -ErrorAction Stop
        $moved.Add($item.Name)
        if ($QaAbortAfterMove) { [Environment]::Exit(91) }
    }
    foreach ($item in Get-ChildItem -LiteralPath $Stage -Force) {
        if ($item.Name -eq '.local') { throw 'Staged package contains local data.' }
        $copied.Add($item.Name)
        Copy-Item -LiteralPath $item.FullName -Destination $Root -Recurse -Force -ErrorAction Stop
        if ($QaFailAfterCopy) { throw 'QA injected failure after partial copy.' }
    }
    $copied.Add('installed.json')
    [IO.File]::WriteAllText($markerPath,(@{root=$Root;version=1;application='codex-mobile-bridge';appVersion=$Version}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
    if ([version]([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Root 'CodexMobileConnector.exe')).ProductVersion) -ne $incoming) { throw 'Installed application version verification failed.' }
    # Commit the harmless preference before relaunching the GUI; rollback retains its prior bytes.
    if ($Language) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root '.local') | Out-Null
        $languageTemp = $languagePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        $languagePrevious = $languageTemp + '.previous'
        try {
            [IO.File]::WriteAllText($languageTemp,(@{language=$Language}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
            if (Test-Path -LiteralPath $languagePath) { [IO.File]::Replace($languageTemp,$languagePath,$languagePrevious) }
            else { [IO.File]::Move($languageTemp,$languagePath) }
        } finally { foreach ($temporary in @($languageTemp,$languagePrevious)) { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } } }
    }
    if ($QaFailAfterLanguage) { throw 'QA injected failure after language persistence.' }
    if ($QaAbortAfterLanguage) { [Environment]::Exit(93) }
    if ($wasBridge) { & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/start.mjs') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Previous bridge could not be restarted.' } }
    if ($wasActive) {
        $request = '{"action":"connect","reason":"manual"}' | & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/connector-gui.mjs') | ConvertFrom-Json
        if (-not $request.ok -or -not $request.recoveryCompleted) { throw 'Previous connection could not be resumed.' }
    }
    if ($wasGui) { Start-Process -FilePath (Join-Path $Root 'CodexMobileConnector.exe') -ArgumentList @('--install-root',('"'+$Root+'"'),'--tray') -WindowStyle Hidden }
    $journal.phase='committed'
    [IO.File]::WriteAllText($journalTemp,($journal | ConvertTo-Json -Depth 5 -Compress),(New-Object Text.UTF8Encoding($false)))
    [IO.File]::Replace($journalTemp,$journalPath,$journalPrevious)
    Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue
    if ($QaAbortCommitted) { [Environment]::Exit(92) }
    $committed = $true
} catch {
    $reason = $_.Exception.Message
    try {
        if ($moved.Count -gt 0) {
            Stop-Owned @('scripts/connector-login.mjs','scripts/start.mjs','scripts/supervisor.mjs') $false
            Stop-Owned @('scripts/start-connector.mjs','scripts/collaboration-mcp.mjs','src/server.mjs') $true
        }
        foreach ($name in $copied) { $target=Join-Path $Root $name; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop } }
        foreach ($name in $moved) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $Root -ErrorAction Stop }
        if ($hadControl) { [IO.File]::WriteAllBytes($controlPath,$controlBytes) }
        elseif (Test-Path -LiteralPath $controlPath) { Remove-Item -LiteralPath $controlPath -Force }
        if ($hadLanguage) { [IO.File]::WriteAllBytes($languagePath,$languageBytes) }
        elseif (Test-Path -LiteralPath $languagePath) { Remove-Item -LiteralPath $languagePath -Force }
        if ($wasBridge -and -not $Repair -and @(Owned-Processes @('src/server.mjs') $false).Count -eq 0) { & $oldNode (Join-Path $Root 'scripts/start.mjs') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Previous bridge could not be restarted.' } }
        if ($wasActive -and -not $Repair -and @(Owned-Processes @('scripts/connector-login.mjs','scripts/start-connector.mjs') $false).Count -eq 0) {
            $resumed = '{"action":"connect","reason":"manual"}' | & $oldNode $oldGui | ConvertFrom-Json
            if (-not $resumed.ok -or -not $resumed.recoveryCompleted) { throw 'Previous connection could not be resumed.' }
        }
        if ($wasGui -and -not $Repair -and @(Owned-Processes @() $true).Count -eq 0) { Start-Process -FilePath $oldExe -ArgumentList @('--install-root',('"'+$Root+'"'),'--tray') -WindowStyle Hidden }
        # Keep the verified journal's prior active intent until forward repair.
        # Restarting the broken old runtime/gui would make every retry fail.
        $rolledBack = -not ($Repair -and ($wasActive -or $wasBridge -or $wasGui))
    } catch {
        throw "Upgrade failed: $reason. Rollback or connection recovery also failed: $($_.Exception.Message). Backup retained at $backup"
    }
    throw "Upgrade failed and previous files were restored: $reason"
} finally {
    if ($committed -or $rolledBack) {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue }
    }
}
