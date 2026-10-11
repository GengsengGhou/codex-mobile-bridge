# Pairing network diagnostics / 配对网络诊断

浏览器能打开登录页，只证明浏览器的访问路径正常。连接器自带 Node 的 DNS、代理路径、证书信任库可能不同；仅凭 `fetch failed` 不能确定是 Clash/VPN、证书、DNS 或服务器问题。

The browser and bundled Node can use different network paths, proxy settings and certificate stores. A successful browser login-page load does not establish the cause of a Node `fetch failed` error.

## Run on the affected Windows computer

Copy these three files together into a folder: `diagnose-network.ps1`, `diagnose-network.mjs`, and `network-error.mjs` from `scripts/`. Open PowerShell in that folder and run:

```powershell
& .\diagnose-network.ps1 -Origin 'https://codex.example.com'
```

自定义安装目录需明确指定绝对路径，例如：

```powershell
& .\diagnose-network.ps1 -Origin 'https://codex.example.com' -InstallRoot 'D:\Apps\CodexMobileConnector'
```

The default runtime is `%LOCALAPPDATA%\CodexMobileConnector\runtime\node.exe`. No separately installed Node is required. If script execution is blocked, the Node-only probe can be run directly without changing execution policy:

```powershell
& "$env:LOCALAPPDATA\CodexMobileConnector\runtime\node.exe" .\diagnose-network.mjs 'https://codex.example.com'
```

Return the JSON output and whether the browser opens the same origin. 请发送 JSON 输出，以及浏览器是否能打开同一地址。不需要配对码、密码、设备 token 或连接器配置文件。

## What is collected

- A bounded DNS lookup reports IPv4/IPv6 answer counts, not IP addresses.
- Bundled Node sends exactly one anonymous GET to `/`, does not follow redirects or read the body, and uses a 10-second timeout. DNS has a separate 10-second bound.
- The PowerShell wrapper sends one anonymous Windows/.NET GET to `/` using the system default proxy and certificate validation. It does not follow redirects or read the body. It has a 10-second request timeout and gives the Node subprocess at most 30 seconds.
- Windows proxy settings and proxy/CA-related environment variables are reported only as present/enabled flags. Proxy URLs, credentials, PAC URLs, certificate paths, response bodies, arbitrary error text and URL queries are omitted.
- No connector credential files are read. No pairing POST, account operation, certificate bypass, automatic retry, registry/environment/firewall/installation change, or execution-policy change occurs. Requests can appear in normal server access logs.

The supplied origin must be HTTPS and contain no credentials, path, query or fragment. An HTTP status, including 401/403/404/5xx or a redirect, proves receipt of an HTTP response; it does not prove the pairing endpoint or persistent WebSocket is working.

## Reading the result

| Category | Meaning / 下一步 |
| --- | --- |
| DNS | Node hostname resolution failed. Compare resolver behavior on the affected computer. |
| TLS | Certificate validation or TLS handshake failed. Inspect the computer clock, certificate trust and possible interception. Do not disable certificate validation. |
| TIMEOUT | The request exceeded its bound. Check route/proxy/firewall reachability; the category alone cannot identify which component caused the delay. |
| REFUSED | The destination actively refused the connection. |
| RESET | The connection closed before a response completed. |
| UNREACHABLE | The OS reported an unreachable route. |
| MULTIPLE | Bounded nested connection attempts contain several allowlisted causes; inspect the accompanying codes. |
| CANCELLED / UNKNOWN | Request cancellation or no recognized safe cause code. Further evidence is needed. |

Windows HTTPS success plus Node failure suggests a difference in routes, proxy use or certificate stores. Windows proxy flags and environment-variable presence are clues, not proof of use. Node behavior depends on version and flags; the tool reports the actual installed Node version. A TUN/VPN can affect Node even without proxy environment variables. Windows/.NET is a comparison client, not an exact reproduction of browser networking.

## Pairing behavior

Transport failures now show a safe category in Chinese and English, rather than forwarding raw `fetch failed` or nested error text. Pairing submits once and does not retry automatically. A network failure can occur after the server consumes the pairing code. 先在网页设备列表确认结果，再决定撤销设备或重新生成配对信息。Existing HTTP-error, response-validation and credential-saving behavior is preserved.

The diagnostic is for locating the affected computer's failure. Local loopback test fixtures and success on another computer do not identify that computer's actual root cause.
