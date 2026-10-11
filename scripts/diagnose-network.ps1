param([string]$Origin, [string]$InstallRoot)
# Read-only. No policy, registry, proxy, firewall or connector-state changes.
$ErrorActionPreference = 'Stop'
try {
    $uri = [Uri]$Origin
    if ($Origin -ne $Origin.Trim() -or $Origin -notmatch '^https://[^/?#]+/?$' -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Invalid origin' }
    if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'CodexMobileConnector' }
    if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be absolute' }
    $node = Join-Path $InstallRoot 'runtime/node.exe'
    $report = [ordered]@{ schema = 1; readOnly = $true; windowsProxy = [ordered]@{} }
    try {
        $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        $report.windowsProxy = @{ readOk = $true; enabled = [bool]$settings.ProxyEnable; pacConfigured = [bool]$settings.AutoConfigURL; proxyServerConfigured = [bool]$settings.ProxyServer }
    } catch { $report.windowsProxy = @{ readOk = $false; category = 'PROXY_SETTINGS_UNAVAILABLE' } }
    $response = $null; $pending = $null
    try {
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.Method = 'GET'; $request.AllowAutoRedirect = $false; $request.Timeout = 10000; $request.ReadWriteTimeout = 10000
        $request.UseDefaultCredentials = $false
        $pending = $request.BeginGetResponse($null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(10000)) {
            $request.Abort()
            throw [Net.WebException]::new('Diagnostic timeout', [Net.WebExceptionStatus]::Timeout)
        }
        $response = $request.EndGetResponse($pending)
        $report.windowsHttps = @{ transportOk = $true; status = [int]$response.StatusCode }
    } catch [Net.WebException] {
        if ($_.Exception.Response) { $response = $_.Exception.Response; $report.windowsHttps = @{ transportOk = $true; status = [int]$response.StatusCode } }
        else {
            $category = switch ($_.Exception.Status.ToString()) {
                'NameResolutionFailure' { 'DNS' } 'ProxyNameResolutionFailure' { 'PROXY_DNS' }
                'TrustFailure' { 'TLS' } 'SecureChannelFailure' { 'TLS' } 'Timeout' { 'TIMEOUT' }
                'ConnectFailure' { 'CONNECTION' } 'ConnectionClosed' { 'RESET' } default { 'UNKNOWN' }
            }
            $report.windowsHttps = @{ transportOk = $false; category = $category }
        }
    } catch { $report.windowsHttps = @{ transportOk = $false; category = 'UNKNOWN' } }
    finally { if ($response) { $response.Close() }; if ($pending) { $pending.AsyncWaitHandle.Close() } }
    if (Test-Path -LiteralPath $node -PathType Leaf) {
        # Suppress raw runtime stderr: installed Node startup errors can contain paths.
        $process = $null
        try {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = $node
            $info.Arguments = '"' + (Join-Path $PSScriptRoot 'diagnose-network.mjs') + '" "' + $uri.GetLeftPart([UriPartial]::Authority) + '"'
            $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
            $process = [Diagnostics.Process]::Start($info)
            $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Diagnostic timeout' }
            $report.node = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        } catch { $report.node = @{ diagnosticError = 'NODE_DIAGNOSTIC_FAILED_OR_TIMED_OUT' } }
        finally { if ($process) { $process.Dispose() } }
    } else { $report.node = @{ diagnosticError = 'INSTALLED_NODE_NOT_FOUND'; help = 'Specify the absolute app directory with -InstallRoot.' } }
    $report | ConvertTo-Json -Depth 8
} catch { @{ schema = 1; readOnly = $true; diagnosticError = 'INVALID_INPUT_OR_DIAGNOSTIC_FAILURE'; help = 'Use an HTTPS origin without path/query/credentials and an absolute InstallRoot if needed.' } | ConvertTo-Json }
