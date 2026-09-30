param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$marker = Get-Content -LiteralPath (Join-Path $Root 'installed.json') -Raw | ConvertFrom-Json
if ($marker.version -ne 1 -or [IO.Path]::GetFullPath($marker.root) -cne $Root) { throw 'Installation ownership cannot be verified.' }
$node = Join-Path $Root 'runtime/node.exe'
$gui = Join-Path $Root 'scripts/connector-gui.mjs'
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $gui)) {
    $result = '{"action":"quit"}' | & $node $gui | ConvertFrom-Json
    if (-not $result.ok -or -not $result.disconnectVerified) { throw 'Connector pause/stop could not be confirmed. Uninstall was stopped.' }
}
$expected = '"' + (Join-Path $Root 'CodexMobileConnector.exe') + '"'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$current = (Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue).CodexMobileCompanion
if ($current -ceq $expected) { Remove-ItemProperty -LiteralPath $run -Name CodexMobileCompanion }
# Remove only registrations whose commands point to this verified installation.
$properties = Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue
$sha = [Security.Cryptography.SHA256]::Create()
try { $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-','').ToLowerInvariant().Substring(0,24) } finally { $sha.Dispose() }
$companionName = 'CodexMobileCompanion-' + $identity
if ($properties.PSObject.Properties[$companionName].Value -ceq ($expected + ' --tray')) { Remove-ItemProperty -LiteralPath $run -Name $companionName }
foreach ($property in $properties.PSObject.Properties) {
    $legacyCommand = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts/connector-login.ps1') + '"'
    $bridgeCommand = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts/windows-startup.ps1') + '" -NodePath "' + $node + '"'
    if (($property.Name -ceq ('CodexMobileConnector-' + $identity) -and [string]$property.Value -ceq $legacyCommand) -or ($property.Name -ceq ('CodexMobileBridge-' + $identity) -and [string]$property.Value -ceq $bridgeCommand)) { Remove-ItemProperty -LiteralPath $run -Name $property.Name }
}
$scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
function CurrentUserTask($principal) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($principal -ceq $sid) { return $true }
    try { return (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value -ceq $sid }
    catch { return $false }
}
foreach ($task in $folder.GetTasks(0)) {
    $taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts/connector-login.ps1') + '"'
    $taskExecutable = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if ($task.Name -ceq ('CodexMobileConnector-' + $identity) -and $task.Definition.Actions.Count -eq 1 -and $task.Definition.Actions.Item(1).Path -ceq $taskExecutable -and $task.Definition.Actions.Item(1).Arguments -ceq $taskArguments -and (CurrentUserTask $task.Definition.Principal.UserId)) { $folder.DeleteTask($task.Name,0) }
}
function Owned-Processes($entries, $includeGui) {
    @(foreach ($process in Get-CimInstance Win32_Process) {
        if ($process.ProcessId -eq $PID -or -not $process.ExecutablePath) { continue }
        $owned = $includeGui -and $process.ExecutablePath -ceq (Join-Path $Root 'CodexMobileConnector.exe')
        if ($process.ExecutablePath -ceq $node -and $process.CommandLine) {
        foreach ($entry in $entries) {
            $script = Join-Path $Root $entry
            if ($process.CommandLine -match ('(?i)(?:^|\s)"'+[regex]::Escape($script)+'"(?:\s|$)') -or $process.CommandLine -match ('(?i)(?:^|\s)'+[regex]::Escape($script)+'(?:\s|$)')) { $owned = $true }
        }
        }
        if ($owned) { $process }
    })
}
function Stop-Owned($entries, $includeGui) {
    for ($attempt=0; $attempt -lt 10; $attempt++) {
        $owned = @(Owned-Processes $entries $includeGui)
        if ($owned.Count -eq 0) { return }
        foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 100
    }
    if (@(Owned-Processes $entries $includeGui).Count -ne 0) { throw 'Owned installation processes could not be stopped. Uninstall was stopped.' }
}
# Stop launchers/supervisors before their children so no replacement can escape a snapshot.
Stop-Owned @('scripts/connector-login.mjs','scripts/start.mjs','scripts/supervisor.mjs') $false
Stop-Owned @('scripts/start-connector.mjs','src/server.mjs') $true
if (@(Owned-Processes @('scripts/connector-login.mjs','scripts/start-connector.mjs','scripts/start.mjs','scripts/supervisor.mjs','src/server.mjs') $true).Count -ne 0) { throw 'Installation processes are still running.' }
function Remove-OwnedShortcuts([string]$InstallationRoot, [string[]]$Directories) {
    $executable = Join-Path $InstallationRoot 'CodexMobileConnector.exe'
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($directory in $Directories) {
            foreach ($name in @(('Codex '+[char]0x624B+[char]0x673A+[char]0x6865+[char]0x63A5+'.lnk'), 'Codex Mobile Connector.lnk')) {
                $shortcut = Join-Path $directory $name
                if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) { continue }
                $link = $shell.CreateShortcut($shortcut)
                try {
                    if ($link.TargetPath -ieq $executable -and $link.WorkingDirectory -ieq $InstallationRoot -and [string]::IsNullOrWhiteSpace($link.Arguments)) { Remove-Item -LiteralPath $shortcut }
                } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
            }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
$default = Join-Path $env:LOCALAPPDATA 'CodexMobileConnector'
if ($Root -ieq $default) {
    Remove-OwnedShortcuts $Root @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'))
    Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector' -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
    if ($item.Name -ne '.local') { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
}
