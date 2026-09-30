param([string]$SetupExecutable = (Join-Path $PSScriptRoot '../dist/CodexMobileConnector-Setup.exe'))
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('codex-shortcut-qa-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $fixture 'app'
$programs = Join-Path $fixture 'Programs'
$desktop = Join-Path $fixture 'Desktop'
$name = 'Codex '+[char]0x624B+[char]0x673A+[char]0x6865+[char]0x63A5+'.lnk'
$legacy = 'Codex Mobile Connector.lnk'
$shell = New-Object -ComObject WScript.Shell
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Shortcut([string]$path, [string]$target, [string]$working, [string]$arguments = '') {
    $link = $shell.CreateShortcut($path)
    try { $link.TargetPath=$target; $link.WorkingDirectory=$working; $link.Arguments=$arguments; $link.IconLocation=$target+',0'; $link.Save() }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
}
try {
    New-Item -ItemType Directory -Path $root,$programs,$desktop | Out-Null
    $executable = Join-Path $root 'CodexMobileConnector.exe'
    Copy-Item -LiteralPath $SetupExecutable -Destination $executable
    $assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($SetupExecutable))
    Assert ($assembly.GetName().Name -eq 'CodexMobileConnector') 'Installed app still has an installer assembly identity.'
    $version=[Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::GetFullPath($SetupExecutable))
    Assert ($version.OriginalFilename -eq 'CodexMobileConnector.exe' -and $version.ProductName -ne '' -and $version.FileDescription -ne '') 'Installed app metadata is missing or classified as Setup.'
    $method = $assembly.GetType('ConnectorBootstrap').GetMethod('RefreshShortcuts',[Reflection.BindingFlags]'Static,NonPublic')
    function Refresh([bool]$includeDesktop) { $method.Invoke($null,[object[]]@([string]$root,[string]$programs,[string]$desktop,[bool]$includeDesktop)) | Out-Null }
    foreach ($directory in @($programs,$desktop)) { Shortcut (Join-Path $directory $legacy) $executable $root }
    Refresh $true
    foreach ($directory in @($programs,$desktop)) {
        $path = Join-Path $directory $name
        Assert (Test-Path -LiteralPath $path) 'Install/upgrade shortcut missing.'
        Assert (-not (Test-Path -LiteralPath (Join-Path $directory $legacy))) 'Owned legacy shortcut was not migrated.'
        $link=$shell.CreateShortcut($path)
        try { Assert ($link.TargetPath -ieq $executable -and $link.WorkingDirectory -ieq $root -and $link.Arguments -eq '' -and $link.IconLocation -ieq ($executable+',0')) 'Shortcut target, working directory, arguments or icon is wrong.' }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
        $identityMethod=$assembly.GetType('ShortcutIdentity').GetMethod('Ensure')
        Assert (-not $identityMethod.Invoke($null,[object[]]@([string]$path))) 'Saved shortcut lacks the stable AppUserModelID.'
    }
    $start = Join-Path $programs $name
    $before = (Get-Item -LiteralPath $start).LastWriteTimeUtc.Ticks
    Refresh $true
    Assert ((Get-Item -LiteralPath $start).LastWriteTimeUtc.Ticks -eq $before) 'Valid shortcuts were unnecessarily rewritten.'
    Remove-Item -LiteralPath (Join-Path $desktop $name),$start
    Refresh $false
    Assert (Test-Path -LiteralPath $start) 'Ordinary launch failed to repair Start menu shortcut.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $desktop $name))) 'Ordinary launch recreated a deleted desktop shortcut.'
    Shortcut (Join-Path $programs $legacy) $executable $root '--foreign'
    Shortcut (Join-Path $desktop $legacy) (Join-Path $fixture 'foreign.exe') $fixture
    Refresh $true
    Assert (Test-Path -LiteralPath (Join-Path $programs $legacy)) 'Migration removed a foreign-argument link.'
    Assert (Test-Path -LiteralPath (Join-Path $desktop $legacy)) 'Migration removed a foreign-target link.'
    Remove-Item -LiteralPath $start
    Shortcut $start (Join-Path $fixture 'foreign.exe') $fixture
    $conflict = $false
    try { Refresh $true } catch { $conflict = $true }
    Assert $conflict 'Install silently overwrote a foreign Chinese shortcut.'
    # Load only the production cleanup function; never execute the real uninstall script.
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'uninstall-connector.ps1'),[ref]$tokens,[ref]$errors)
    Assert ($errors.Count -eq 0) 'Uninstall script parse failed.'
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-OwnedShortcuts'},$true)
    Invoke-Expression $function.Extent.Text
    Remove-OwnedShortcuts $root @($programs,$desktop)
    Assert (Test-Path -LiteralPath $start) 'Uninstall removed a foreign Chinese link.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $desktop $name))) 'Uninstall left an owned Chinese desktop link.'
    Assert (Test-Path -LiteralPath (Join-Path $programs $legacy)) 'Uninstall removed a foreign-argument link.'
    Assert (Test-Path -LiteralPath (Join-Path $desktop $legacy)) 'Uninstall removed a foreign-target link.'
    foreach ($directory in @($programs,$desktop)) {
        Shortcut (Join-Path $directory $name) $executable $root
        Shortcut (Join-Path $directory $legacy) $executable $root
    }
    Remove-OwnedShortcuts $root @($programs,$desktop)
    Assert (@(Get-ChildItem -LiteralPath $programs,$desktop -Filter '*.lnk').Count -eq 0) 'Uninstall left owned Chinese/English links.'
    Write-Output 'PASS: real installer COM shortcuts; install/upgrade, migration, idempotence, launch deletion preference, foreign-link conflicts, owned uninstall (temporary paths only).'
} finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    if ([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath($env:TEMP)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
