param([string]$OutputDirectory, [string]$RuntimeExecutable)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function File-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler is unavailable.' }
$stage = Join-Path $env:TEMP ('codex-exe-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $app = Join-Path $stage 'app'
    New-Item -ItemType Directory -Path $app | Out-Null
    foreach ($item in @('package.json','package-lock.json','README.md','src','hub','public','scripts','deploy','docs')) { Copy-Item -LiteralPath (Join-Path $root $item) -Destination $app -Recurse }
    $verification = Join-Path $app 'docs/verification'
    if (Test-Path -LiteralPath $verification) { Remove-Item -LiteralPath $verification -Recurse -Force }
    foreach ($item in Get-ChildItem -LiteralPath $app -Recurse -Force) {
        $relative = $item.FullName.Substring($app.Length + 1).Replace([IO.Path]::DirectorySeparatorChar,[char]'/')
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $relative -match '(^|/)(\.local|work|data|mobile-uploads|coverage|\.cache)(/|$)' -or ($item.Name -ne '.env.example' -and $item.Name -match '^\.env(\.|$)') -or $item.Name -match '\.(sqlite(-.*)?|db(-.*)?|pem|key|pfx|p12|log|tmp)$') { throw "Private or local-only installer input rejected: $relative" }
    }
    New-Item -ItemType Directory -Path (Join-Path $app 'node_modules') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'node_modules/ws') -Destination (Join-Path $app 'node_modules') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $app 'runtime') | Out-Null
    if ($RuntimeExecutable) { Copy-Item -LiteralPath $RuntimeExecutable -Destination (Join-Path $app 'runtime/node.exe') }
    else {
        $base = 'https://nodejs.org/dist/latest-v22.x/'
        $manifest = (Invoke-WebRequest -UseBasicParsing -Uri ($base+'SHASUMS256.txt')).Content
        $match = [regex]::Match($manifest,'(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
        if (-not $match.Success) { throw 'Official runtime checksum manifest invalid.' }
        $archive = Join-Path $stage 'node.zip'
        Invoke-WebRequest -UseBasicParsing -Uri ($base+$match.Groups[2].Value) -OutFile $archive
        if ((File-Sha256 $archive) -ne $match.Groups[1].Value) { throw 'Runtime checksum mismatch.' }
        [IO.Compression.ZipFile]::ExtractToDirectory($archive,(Join-Path $stage 'node'))
        Copy-Item -LiteralPath (Join-Path $stage ('node/'+$match.Groups[2].Value.Replace('.zip','')+'/node.exe')) -Destination (Join-Path $app 'runtime/node.exe')
        Copy-Item -LiteralPath (Join-Path $stage ('node/'+$match.Groups[2].Value.Replace('.zip','')+'/LICENSE')) -Destination (Join-Path $app 'runtime/LICENSE')
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $payload = Join-Path $stage 'payload.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($app,$payload)
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $output = Join-Path $OutputDirectory 'CodexMobileConnector-Setup.exe'
    & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:Microsoft.CSharp.dll "/win32manifest:$(Join-Path $PSScriptRoot 'windows/Connector.manifest')" "/resource:$payload,payload.zip" "/out:$output" (Join-Path $PSScriptRoot 'windows/Connector.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed.' }
    $sha = File-Sha256 $output
    Set-Content -LiteralPath ($output+'.sha256') -Value ($sha+'  '+[IO.Path]::GetFileName($output)) -Encoding ascii
    Write-Output "Windows installer built: $output"
} finally {
    if ([IO.Path]::GetFullPath($stage).StartsWith([IO.Path]::GetFullPath($env:TEMP)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
