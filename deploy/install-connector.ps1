param([string]$HubOrigin, [string]$DeviceName, [switch]$PrepareOnly, [switch]$ForcePortableRuntime)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$nodeBinary = $null
$installed = Get-Command node -ErrorAction SilentlyContinue
if ($installed -and -not $ForcePortableRuntime) {
    $version = (& $installed.Source --version).TrimStart('v').Split('.')
    if ([int]$version[0] -gt 22 -or ([int]$version[0] -eq 22 -and [int]$version[1] -ge 16)) { $nodeBinary = $installed.Source }
}
if (-not $nodeBinary) {
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') { throw 'Automatic portable runtime setup currently supports Windows x64. Install Node.js 22.16+ for this architecture.' }
    $tools = Join-Path (Get-Location) '.local/tools'
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $base = 'https://nodejs.org/dist/latest-v22.x/'
    $manifest = (Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
    $match = [regex]::Match($manifest, '(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
    if (-not $match.Success) { throw 'Official Node.js checksum manifest did not contain the expected Windows runtime.' }
    $archive = Join-Path $tools $match.Groups[2].Value
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $match.Groups[2].Value) -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { Remove-Item -LiteralPath $archive; throw 'Portable Node.js checksum verification failed.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
    $nodeBinary = Join-Path $tools ($match.Groups[2].Value.Replace('.zip', '') + '/node.exe')
}
if (-not (Test-Path -LiteralPath 'node_modules/ws/package.json')) {
    $npm = Join-Path (Split-Path -Parent $nodeBinary) 'npm.cmd'
    & $npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if ($PrepareOnly) { Write-Output 'Runtime and bundled dependencies are ready; no device was paired or started.'; exit 0 }
if (-not $HubOrigin) { $HubOrigin = Read-Host 'Hub HTTPS origin' }
if (-not $DeviceName) { $DeviceName = Read-Host 'Device name' }
& $nodeBinary scripts/onboard-connector.mjs $HubOrigin $DeviceName
if ($LASTEXITCODE -ne 0) { throw 'Local bridge setup or pairing failed. Follow the message above; no ready device was advertised.' }
& $nodeBinary scripts/connector-login.mjs --register
if ($LASTEXITCODE -ne 0) { throw 'Device is paired, but login recovery setup failed. Follow the message above and rerun the installer.' }
