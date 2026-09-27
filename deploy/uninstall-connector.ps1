param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$marker = Get-Content -LiteralPath (Join-Path $Root 'installed.json') -Raw | ConvertFrom-Json
if ($marker.version -ne 1 -or [IO.Path]::GetFullPath($marker.root) -cne $Root) { throw 'Installation ownership cannot be verified.' }
$expected = '"' + (Join-Path $Root 'CodexMobileConnector.exe') + '"'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$current = (Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue).CodexMobileCompanion
if ($current -ceq $expected) { Remove-ItemProperty -LiteralPath $run -Name CodexMobileCompanion }
# Remove only registrations whose commands point to this verified installation.
$properties = Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue
foreach ($property in $properties.PSObject.Properties) {
    if (($property.Name -like 'CodexMobileConnector-*' -and [string]$property.Value -like ('*"'+(Join-Path $Root 'scripts/connector-login.ps1')+'"*')) -or ($property.Name -like 'CodexMobileBridge-*' -and [string]$property.Value -like ('*"'+(Join-Path $Root 'scripts/windows-startup.ps1')+'"*'))) { Remove-ItemProperty -LiteralPath $run -Name $property.Name }
}
$scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
foreach ($task in $folder.GetTasks(0)) {
    if ($task.Name -like 'CodexMobileConnector-*' -and $task.Definition.Actions.Count -eq 1 -and $task.Definition.Actions.Item(1).Arguments -like ('*"'+(Join-Path $Root 'scripts/connector-login.ps1')+'"*')) { $folder.DeleteTask($task.Name,0) }
}
foreach ($process in Get-CimInstance Win32_Process) {
    if ($process.ProcessId -ne $PID -and $process.CommandLine -and $process.ExecutablePath -and ([IO.Path]::GetFullPath($process.ExecutablePath)).StartsWith($Root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
}
$default = Join-Path $env:LOCALAPPDATA 'CodexMobileConnector'
if ($Root -ieq $default) {
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Mobile Connector.lnk'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector' -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
    if ($item.Name -ne '.local') { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
}
