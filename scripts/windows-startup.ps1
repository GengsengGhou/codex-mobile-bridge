param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
Remove-Item Env:CODEX_APP_TOOLS_PIPE_PATH -ErrorAction SilentlyContinue
& $NodePath (Join-Path $PSScriptRoot 'start.mjs')
exit $LASTEXITCODE
