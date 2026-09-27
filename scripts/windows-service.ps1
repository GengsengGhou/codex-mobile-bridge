param([Parameter(Mandatory = $true)][string]$LaunchData)
$ErrorActionPreference = 'Stop'
$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchData)) | ConvertFrom-Json
$logName = if ($launch.logName) { [string]$launch.logName } else { 'bridge' }
if ($logName -notmatch '^[a-z0-9-]{1,40}$') { throw 'Invalid log name.' }
$stdoutLog = Join-Path $launch.root ('.local/' + $logName + '.stdout.log')
$stderrLog = Join-Path $launch.root ('.local/' + $logName + '.stderr.log')
$mutex = $null
$ownsMutex = $false
try {
    if ($launch.mutexName) {
        $mutex = [Threading.Mutex]::new($false, [string]$launch.mutexName)
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { exit 0 }
    }
    Set-Location -LiteralPath $launch.root
    # WMI creates this process outside the calling application's Job Object.
    Remove-Item Env:CODEX_APP_TOOLS_PIPE_PATH -ErrorAction SilentlyContinue
    foreach ($setting in $launch.env.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($setting.Name, [string]$setting.Value, 'Process')
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $launch.nodePath
    $entry = if ($launch.supervisorPath) { $launch.supervisorPath } else { $launch.serverPath }
    $start.Arguments = '"' + $entry + '"'
    $start.WorkingDirectory = $launch.root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $stdout = $null
    $stderr = $null
    $process = $null
    try {
        $stdout = [IO.FileStream]::new($stdoutLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1)
        $stderr = [IO.FileStream]::new($stderrLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1)
        $process = [Diagnostics.Process]::Start($start)
        $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        $process.WaitForExit()
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy))
        exit $process.ExitCode
    } finally {
        if ($stdout) { $stdout.Dispose() }
        if ($stderr) { $stderr.Dispose() }
        if ($process) { $process.Dispose() }
    }
} catch {
    $_ | Out-File -LiteralPath $stderrLog -Append -Encoding utf8
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
