$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
Remove-Item Env:CODEX_APP_TOOLS_PIPE_PATH -ErrorAction SilentlyContinue
# Detach recovery from the login shell and record bootstrap failures for diagnosis.
$log = Join-Path $root '.local/connector-login-bootstrap.log'
try {
    $gui = Join-Path $root 'CodexMobileConnector.exe'
    if (Test-Path -LiteralPath $gui -PathType Leaf) {
        Start-Process -FilePath $gui -ArgumentList '--tray' -WindowStyle Hidden
        exit 0
    }
    $settings = Get-Content -LiteralPath (Join-Path $root '.local/connector-login.json') -Raw | ConvertFrom-Json
    if ($settings.version -ne 1 -or -not (Test-Path -LiteralPath $settings.nodePath -PathType Leaf)) { throw 'Saved connector runtime is unavailable. Run the connector installer again.' }
    ('[{0}] Windows login recovery requested.' -f [DateTime]::UtcNow.ToString('o')) | Out-File -LiteralPath $log -Append -Encoding utf8
    & $settings.nodePath (Join-Path $PSScriptRoot 'connector-login.mjs') --startup 2>&1 | Out-File -LiteralPath $log -Append -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Connector recovery launch failed.' }
} catch {
    $_ | Out-File -LiteralPath $log -Append -Encoding utf8
    exit 1
}
exit $LASTEXITCODE
