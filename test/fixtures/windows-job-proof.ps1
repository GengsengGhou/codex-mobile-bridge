param([string]$NodePath, [string]$ParentScript, [string]$ProofRoot)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeProofJob {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show, reservedSize; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CreateProcess(string app, string command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [BridgeProofJob]::CreateJobObject([IntPtr]::Zero, $null)
$startup = New-Object BridgeProofJob+Startup
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$info = New-Object BridgeProofJob+ProcessInfo
$command = '"' + $NodePath + '" "' + $ParentScript + '" "' + $ProofRoot + '"'
$launchFile = Join-Path $ProofRoot '.local/launch.json'
$portFile = Join-Path $ProofRoot '.local/server.json'
try {
    if (!$job -or ![BridgeProofJob]::CreateProcess($NodePath, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x08000004, [IntPtr]::Zero, $ProofRoot, [ref]$startup, [ref]$info)) { throw 'CreateProcess failed' }
    if (![BridgeProofJob]::AssignProcessToJobObject($job, $info.process)) { throw 'AssignProcessToJobObject failed' }
    [void][BridgeProofJob]::ResumeThread($info.thread)
    $deadline = (Get-Date).AddSeconds(25)
    while (!(Test-Path $portFile) -or !(Test-Path $launchFile)) {
        if ((Get-Date) -gt $deadline) { throw 'Broker proof launch timed out' }
        Start-Sleep -Milliseconds 100
    }
    $server = Get-Content -Raw $portFile | ConvertFrom-Json
    $launch = Get-Content -Raw $launchFile | ConvertFrom-Json
    $url = 'http://127.0.0.1:' + $server.port + '/'
    $before = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5).Content
    if (![BridgeProofJob]::TerminateJobObject($job, 99)) { throw 'TerminateJobObject failed' }
    Start-Sleep -Milliseconds 700
    if (Get-Process -Id $info.pid -ErrorAction SilentlyContinue) { throw 'Disposable parent survived job termination' }
    $after = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5).Content
    if ($before -ne 'bridge-proof' -or $after -ne 'bridge-proof') { throw 'Unexpected proof response' }
    @{ parentPid = $info.pid; brokerPid = $launch.pid; serverPid = $server.pid; port = $server.port; survivedJobTermination = $true } | ConvertTo-Json -Compress
} finally {
    [void][BridgeProofJob]::TerminateJobObject($job, 99)
    if (Test-Path $portFile) { $server = Get-Content -Raw $portFile | ConvertFrom-Json; Stop-Process -Id $server.pid -ErrorAction SilentlyContinue }
    if (Test-Path $launchFile) { $launch = Get-Content -Raw $launchFile | ConvertFrom-Json; Stop-Process -Id $launch.pid -ErrorAction SilentlyContinue }
    if ($info.thread -ne [IntPtr]::Zero) { [void][BridgeProofJob]::CloseHandle($info.thread) }
    if ($info.process -ne [IntPtr]::Zero) { [void][BridgeProofJob]::CloseHandle($info.process) }
    [void][BridgeProofJob]::CloseHandle($job)
}
