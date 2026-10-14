param([Parameter(Mandatory=$true)][string]$Root, [switch]$Notify)
$ErrorActionPreference = 'Stop'
function Show-UninstallNotice([string]$Message, [bool]$Failed) {
    if (-not $Notify) { return }
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($Failed) { [Windows.Forms.MessageBoxIcon]::Warning } else { [Windows.Forms.MessageBoxIcon]::Information }
    [void][Windows.Forms.MessageBox]::Show($Message, 'Codex Mobile Bridge', [Windows.Forms.MessageBoxButtons]::OK, $icon)
}
try {
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Root = [IO.Path]::GetFullPath($Root)
$marker = Get-Content -LiteralPath (Join-Path $Root 'installed.json') -Raw | ConvertFrom-Json
if ($marker.version -ne 1 -or [IO.Path]::GetFullPath($marker.root) -cne $Root) { throw 'Installation ownership cannot be verified.' }
$node = Join-Path $Root 'runtime/node.exe'
$gui = Join-Path $Root 'scripts/connector-gui.mjs'
$collaboration = Join-Path $Root 'scripts/collaboration-lifecycle.mjs'
$compatibility = Join-Path $Root 'scripts/collaboration-compatibility.mjs'
$launch = $null
if (Test-Path -LiteralPath (Join-Path $Root '.local/collaboration-launcher.json')) {
    $launch = & $node $compatibility --launch-info --install-root $Root | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $launch.command -or $launch.args.Count -ne 2 -or $launch.args[0] -cne '--install-root' -or $launch.args[1] -cne $Root) { throw 'Collaboration launcher ownership cannot be verified.' }
}
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $collaboration)) {
    $cleaned = & $node $collaboration --uninstall | ConvertFrom-Json
    if (-not $cleaned.ok -or -not $cleaned.disabled) { throw ('Computer collaboration cleanup could not be confirmed. Existing Codex configuration was preserved. Uninstall was stopped. ' + $cleaned.error) }
}
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
        if ($launch -and $process.ExecutablePath -ceq $launch.command -and $process.CommandLine -match ('(?i)(?:^|\s)"?--install-root"?\s+"'+[regex]::Escape($Root)+'"(?:\s|$)')) { $owned = $true }
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
Stop-Owned @('scripts/start-connector.mjs','scripts/collaboration-mcp.mjs','src/server.mjs') $true
if (@(Owned-Processes @('scripts/connector-login.mjs','scripts/start-connector.mjs','scripts/start.mjs','scripts/supervisor.mjs','scripts/collaboration-mcp.mjs','src/server.mjs') $true).Count -ne 0) { throw 'Installation processes are still running.' }
if ($launch) {
    $removed = & $node $compatibility --remove-launcher --install-root $Root | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $removed.removed) { throw 'Collaboration launcher cleanup could not be confirmed. Uninstall was stopped.' }
}
function Remove-OwnedShortcuts([string]$InstallationRoot, [string[]]$Directories) {
    $executable = Join-Path $InstallationRoot 'CodexMobileConnector.exe'
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($directory in $Directories) {
            foreach ($name in @(('Codex '+[char]0x624B+[char]0x673A+[char]0x6865+[char]0x63A5+'.lnk'), 'Codex Mobile Connector.lnk', 'Codex Mobile Bridge.lnk')) {
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
$warning = if ($cleaned.configurationPreserved) { [string]$cleaned.warning } else { $null }
[Console]::Out.WriteLine((@{ ok=$true; uninstalled=$true; configurationPreserved=[bool]$cleaned.configurationPreserved; warning=$warning } | ConvertTo-Json -Compress))
$message = "卸载已完成。已保存的配对和本机数据已保留。`nUninstall completed. Saved pairing and local data were retained."
if ($warning) { $message += "`n`n" + $warning }
Show-UninstallNotice $message $false
} catch {
    $failure = $_.Exception.Message
    [Console]::Out.WriteLine((@{ ok=$false; uninstalled=$false; error=$failure } | ConvertTo-Json -Compress))
    try { Show-UninstallNotice ("卸载未完成。请保留本机数据并按下面信息重试。`nUninstall did not complete. Keep local data and retry after resolving this issue.`n`n" + $failure) $true } catch { [Console]::Error.WriteLine($_.Exception.Message) }
    exit 1
}
