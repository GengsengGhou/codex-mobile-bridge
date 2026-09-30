param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$Version,
    [switch]$QaFailAfterCopy,
    [switch]$QaAbortAfterMove,
    [switch]$QaAbortCommitted,
    [switch]$Recover
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$Stage = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
$default = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexMobileConnector')).TrimEnd('\')
if (($QaFailAfterCopy -or $QaAbortAfterMove -or $QaAbortCommitted) -and $Root -ieq $default) { throw 'QA failure injection is forbidden for the default installation.' }
if (-not (Test-Path -LiteralPath $Root -PathType Container) -or -not (Test-Path -LiteralPath $Stage -PathType Container)) { throw 'Installation or staged package is missing.' }
if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root cannot be a link.' }
$localPath = Join-Path $Root '.local'
if ((Test-Path -LiteralPath $localPath) -and ((Get-Item -LiteralPath $localPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Local data directory cannot be a link.' }
$journalPath = $Root + '.upgrade-journal.json'
$journalPrevious = $journalPath + '.previous'
$backup = $Root + '.upgrade-backup'
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
    if ($journal.phase -eq 'committed') {
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        Remove-Item -LiteralPath $journalPath -Force
        Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue
        return
    }
    if (-not (Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }
    if (-not (Test-Path -LiteralPath $backup -PathType Container) -or ((Get-Item -LiteralPath $backup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Interrupted upgrade backup is invalid or linked.' }
    $savedMarker = if (Test-Path -LiteralPath (Join-Path $backup 'installed.json')) { Join-Path $backup 'installed.json' } else { Join-Path $Root 'installed.json' }
    $savedExe = if (Test-Path -LiteralPath (Join-Path $backup 'CodexMobileConnector.exe')) { Join-Path $backup 'CodexMobileConnector.exe' } else { Join-Path $Root 'CodexMobileConnector.exe' }
    if (-not (Test-Path -LiteralPath $savedMarker) -or -not (Test-Path -LiteralPath $savedExe)) { throw 'Interrupted upgrade ownership cannot be verified.' }
    $saved = Get-Content -LiteralPath $savedMarker -Raw | ConvertFrom-Json
    if ($saved.version -ne 1 -or [IO.Path]::GetFullPath($saved.root).TrimEnd('\') -ine $Root -or [Reflection.AssemblyName]::GetAssemblyName($savedExe).Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector')) { throw 'Interrupted upgrade ownership cannot be verified.' }
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
    if ($journal.wasBridge) { & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/start.mjs') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Previous bridge could not be restarted.' } }
    if ($journal.wasActive) {
        $resumed = '{"action":"connect","reason":"manual"}' | & (Join-Path $Root 'runtime/node.exe') (Join-Path $Root 'scripts/connector-gui.mjs') | ConvertFrom-Json
        if (-not $resumed.ok -or -not $resumed.recoveryCompleted) { throw 'Previous connection could not be resumed.' }
    }
    if ($journal.wasGui) { Start-Process -FilePath (Join-Path $Root 'CodexMobileConnector.exe') -ArgumentList @('--install-root',('"'+$Root+'"'),'--tray') -WindowStyle Hidden }
    Remove-Item -LiteralPath $backup -Recurse -Force
    Remove-Item -LiteralPath $journalPath -Force
    Remove-Item -LiteralPath $journalPrevious -Force -ErrorAction SilentlyContinue
    return
}
if (Test-Path -LiteralPath $journalPath) { throw 'Interrupted upgrade must be recovered before starting another.' }
if (Test-Path -LiteralPath $backup) { throw 'Upgrade backup path is already occupied.' }
$markerPath = Join-Path $Root 'installed.json'
$oldExe = Join-Path $Root 'CodexMobileConnector.exe'
$oldNode = Join-Path $Root 'runtime/node.exe'
$oldGui = Join-Path $Root 'scripts/connector-gui.mjs'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $oldExe -PathType Leaf) -or -not (Test-Path -LiteralPath $oldNode -PathType Leaf) -or -not (Test-Path -LiteralPath $oldGui -PathType Leaf)) { throw 'Installation ownership cannot be verified.' }
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.version -ne 1 -or -not ($marker.root -is [string]) -or [IO.Path]::GetFullPath($marker.root).TrimEnd('\') -ine $Root) { throw 'Installation ownership cannot be verified.' }
$oldVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($oldExe).ProductVersion
try { $oldAssembly = [Reflection.AssemblyName]::GetAssemblyName($oldExe) }
catch { throw 'Installed executable is not a valid connector assembly.' }
if ($oldAssembly.Name -cnotin @('CodexMobileConnector-Setup','CodexMobileConnector')) { throw 'Installed executable is not a connector assembly.' }
try { $current = [version]$oldVersion; $incoming = [version]$Version }
catch { throw 'Installed or incoming application version is invalid.' }
if ($current -ge $incoming) { throw "Installed version $oldVersion is not older than $Version." }
if (-not (Test-Path -LiteralPath (Join-Path $Stage 'CodexMobileConnector.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Stage 'runtime/node.exe') -PathType Leaf)) { throw 'Staged package is incomplete.' }
$newVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Stage 'CodexMobileConnector.exe')).ProductVersion
if ([version]$newVersion -ne $incoming) { throw 'Staged application version does not match setup.' }
$controlPath = Join-Path $Root '.local/connector-control.json'
$hadControl = Test-Path -LiteralPath $controlPath -PathType Leaf
$controlBytes = if ($hadControl) { [IO.File]::ReadAllBytes($controlPath) } else { $null }
$intent = if ($hadControl) { Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json } else { $null }
if ($intent -and ($intent.paused -isnot [bool] -or $intent.autoStart -isnot [bool])) { throw 'Saved connection intent is damaged; upgrade was stopped.' }
$paired = Test-Path -LiteralPath (Join-Path $Root '.local/hub-connector.json') -PathType Leaf
$entries = @('scripts/connector-login.mjs','scripts/start-connector.mjs','scripts/start.mjs','scripts/supervisor.mjs','src/server.mjs')
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
$wasActive = $paired -and $intent -and -not $intent.paused -and @($before | Where-Object { $_.CommandLine -match 'connector-login\.mjs|start-connector\.mjs' }).Count -gt 0
$wasBridge = @($before | Where-Object { $_.CommandLine -match 'src[\\/]server\.mjs' }).Count -gt 0
$moved = New-Object System.Collections.Generic.List[string]
$copied = New-Object System.Collections.Generic.List[string]
$committed = $false
$rolledBack = $false
$journal = @{ version=1; root=$Root; backup=$backup; phase='inProgress'; originalNames=@(Get-ChildItem -LiteralPath $Root -Force | Where-Object Name -ne '.local' | ForEach-Object Name); stagedNames=@(Get-ChildItem -LiteralPath $Stage -Force | ForEach-Object Name)+@('installed.json'); hadControl=$hadControl; controlBase64=if($hadControl){[Convert]::ToBase64String($controlBytes)}else{$null}; wasActive=[bool]$wasActive; wasBridge=[bool]$wasBridge; wasGui=[bool]$wasGui }
$journalTemp = $journalPath + '.tmp'
[IO.File]::WriteAllText($journalTemp,($journal | ConvertTo-Json -Depth 5 -Compress),(New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $journalTemp -Destination $journalPath -ErrorAction Stop
New-Item -ItemType Directory -Path $backup | Out-Null
try {
    if ($wasActive) {
        $request = '{"action":"quit"}' | & $oldNode $oldGui | ConvertFrom-Json
        if (-not $request.ok -or -not $request.disconnectVerified) { throw 'Old connector did not confirm a clean stop.' }
        if ($hadControl) { [IO.File]::WriteAllBytes($controlPath,$controlBytes) }
    }
    Stop-Owned @('scripts/connector-login.mjs','scripts/start.mjs','scripts/supervisor.mjs') $false
    Stop-Owned @('scripts/start-connector.mjs','src/server.mjs') $true
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
    Copy-Item -LiteralPath (Join-Path $backup 'installed.json') -Destination $markerPath -ErrorAction Stop
    $copied.Add('installed.json')
    if ([version]([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Root 'CodexMobileConnector.exe')).ProductVersion) -ne $incoming) { throw 'Installed application version verification failed.' }
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
            Stop-Owned @('scripts/start-connector.mjs','src/server.mjs') $true
        }
        foreach ($name in $copied) { $target=Join-Path $Root $name; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop } }
        foreach ($name in $moved) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $Root -ErrorAction Stop }
        if ($hadControl) { [IO.File]::WriteAllBytes($controlPath,$controlBytes) }
        elseif (Test-Path -LiteralPath $controlPath) { Remove-Item -LiteralPath $controlPath -Force }
        if ($wasBridge -and @(Owned-Processes @('src/server.mjs') $false).Count -eq 0) { & $oldNode (Join-Path $Root 'scripts/start.mjs') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Previous bridge could not be restarted.' } }
        if ($wasActive -and @(Owned-Processes @('scripts/connector-login.mjs','scripts/start-connector.mjs') $false).Count -eq 0) {
            $resumed = '{"action":"connect","reason":"manual"}' | & $oldNode $oldGui | ConvertFrom-Json
            if (-not $resumed.ok -or -not $resumed.recoveryCompleted) { throw 'Previous connection could not be resumed.' }
        }
        if ($wasGui -and @(Owned-Processes @() $true).Count -eq 0) { Start-Process -FilePath $oldExe -ArgumentList @('--install-root',('"'+$Root+'"'),'--tray') -WindowStyle Hidden }
        $rolledBack = $true
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
