param([string]$OutputDirectory,[string[]]$States=@('install','unpaired','waiting','connecting','online','paused','error','settings','legacy','replace'),[string[]]$Scales=@('1','1.5','2'))
$ErrorActionPreference='Stop'
if(-not $OutputDirectory){$OutputDirectory=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'work/native-ui'}
New-Item -ItemType Directory -Force -Path $OutputDirectory|Out-Null
$fixture=Join-Path $env:TEMP ('codex-native-ui-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'runtime'),(Join-Path $fixture 'scripts')|Out-Null
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $fixture 'runtime/node.exe')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native-qa-status.mjs') -Destination (Join-Path $fixture 'scripts/connector-gui.mjs')
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $resources=@();foreach($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'icons') -Filter '*.png'){$resources+='/resource:'+ $file.FullName + ',icons.' + $file.Name}
    $resources+='/resource:'+ (Join-Path $PSScriptRoot 'icons/connector.ico') + ',icons.connector.ico'
    $exe=Join-Path $fixture 'NativeUiQa.exe'
    & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /main:NativeUiQa /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:Microsoft.CSharp.dll "/out:$exe" $resources (Join-Path $PSScriptRoot 'Connector.cs') (Join-Path $PSScriptRoot 'NativeUiQa.cs')
    if($LASTEXITCODE -ne 0){throw 'Native QA compilation failed.'}
    foreach($state in $States){
        $fixtureState=$state;if($state -eq 'settings' -or $state -eq 'replace'){$fixtureState='online'};if($state -eq 'legacy'){$fixtureState='unpaired'}
        Set-Content -LiteralPath (Join-Path $fixture 'scripts/state.txt') -Value $fixtureState -Encoding ascii
        foreach($scale in $Scales){
            $capture=Join-Path $OutputDirectory "$state-$scale.png"
            $process=Start-Process -FilePath $exe -ArgumentList @('"'+$capture+'"',$state,$scale) -WindowStyle Hidden -PassThru
            if(-not $process.WaitForExit(15000)){$process.Kill();throw "Native capture timed out: $state"}
            if(-not (Test-Path -LiteralPath $capture)){throw "Missing native capture: $capture"}
        }
    }
    Write-Output "Native synthetic captures: $OutputDirectory"
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if($resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
