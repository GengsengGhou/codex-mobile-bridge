param([string]$OutputDirectory,[string]$SetupExecutable)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if(-not $OutputDirectory){$OutputDirectory=Join-Path $root 'work/webview-ui'}
if(-not $SetupExecutable){$SetupExecutable=Join-Path $root 'dist/CodexMobileConnector-Setup.exe'}
& node (Join-Path $PSScriptRoot 'verify-webview-ui.mjs') $SetupExecutable $OutputDirectory
if($LASTEXITCODE -ne 0){throw 'Actual WebView2 fixture verification failed.'}
