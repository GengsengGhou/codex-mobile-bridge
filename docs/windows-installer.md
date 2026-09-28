# Windows graphical connector

中文下载与首次配对步骤见 [简易配置教程](quick-start.md#配对-windows-电脑)。安装包和 SHA-256 清单见 [v0.1.0 预发行版](https://github.com/GengsengGhou/codex-mobile-bridge/releases/tag/v0.1.0)；私有仓库下载需要登录有访问权的 GitHub 账号。下面记录安装器细节与构建验证。

Distribute `dist/CodexMobileConnector-Setup.exe` with its published SHA-256 checksum.
The Windows x64 installer embeds the application, its `ws` dependency, and Node.js.
The release build downloads Node.js 22 from the official distribution and verifies
its published SHA-256 before embedding it. No manual Node installation is needed.
The EXE is unsigned; Windows may show publisher reputation information.

Installation uses `%LOCALAPPDATA%\CodexMobileConnector`, a current-user Start menu
shortcut, and current-user login recovery. It does not request administrator rights.
The companion is localized in Chinese. Enter your HTTPS Hub origin and click
“网页登录 / 获取配对码” to open that server's login page; generate a pairing code
on its device page, then paste it alongside the device name. The entered origin
is validated as HTTPS with no user information, path, query, or fragment before
opening it. No personal server domain is prefilled. Pairing can finish before
Codex is open. Pairing immediately saves an explicitly authorized pending
bootstrap marker with the bundled runtime path, registers current-user login
recovery, and launches the independent persistent watcher. The GUI can be closed.
The watcher waits for Codex and an existing ordinary local conversation, then
saves the verified bridge identity, clears pending bootstrap authorization, and
continues bridge/connector recovery. It never creates or sends a conversation
to bootstrap the connection. The pairing code is masked and passed through stdin;
device tokens are saved with a current-user-only file ACL.

The companion includes connection status, retry, Open Codex, server settings,
explicit replacement pairing, and uninstall. An expired or rejected replacement
code preserves the previous credentials and connection. A verified replacement
stops only this installation's old connector. Revoke the old device in its original
Hub afterward. Uninstall removes owned app/startup entries and preserves `.local`
pairing and runtime data. Reinstall can reuse that preserved data. Running the
installer over an existing app refuses before overwriting files; use the existing
companion or uninstall while keeping data before reinstalling.

## Building and verification

On Windows, `npm run release:package` produces the tar archive, Windows ZIP, EXE,
and `dist/SHA256SUMS`. `deploy/build-windows-installer.ps1` can also build the EXE
alone using the installed .NET Framework compiler. Its `-RuntimeExecutable`
option is intended for local testing; release packaging uses the verified official
runtime download.

`node --test test/connector-gui.test.mjs` checks deferred bootstrap, registration
ordering, failed bootstrap, explicit replacement, preservation after rejection,
and token-free status with isolated fixture Hub responses. Run
`node deploy/verify-windows-installer.mjs` after building to execute the actual EXE
in a temporary installation, run its bundled Node, render its actual WinForms
controls, check safe rerun refusal, and uninstall while preserving fixture data.
`node deploy/verify-pending-watcher.mjs` additionally launches the actual WMI
watcher in an isolated app root with an empty Codex home, checks that it survives
without a GUI, prevents duplicate watchers, and is stopped by owned uninstall.
The isolated check does not register real login entries. Deterministic login
tests cover later bootstrap readiness, marker clearing, and retention of saved
scope. An older installation with missing runtime and no explicit first-pairing
marker cannot silently choose a new caller. Corrupt or mismatched saved runtime
is never replaced by deferred bootstrap.

QA overrides do not add login entries or Start menu shortcuts. Evidence is saved
under `docs/verification`, which is excluded from distributable bundles.

Current visual verification uses the running app's `DrawToBitmap` rendering.
Native GUI input and interactive desktop screenshot acceptance were unavailable
because the Windows desktop was locked; no GUI click acceptance is claimed.

## 备用 ZIP 终端安装

下载 `codex-mobile-connector-windows.zip` 并按 `SHA256SUMS` 校验同名项，在自己的用户目录解压。不要放在 EXE 已有安装目录内，也不要混用两个安装目录的 `.local` 数据。

打开 Codex 并确保已有普通本机会话，双击解压目录中的 `deploy/install-connector.cmd`。按终端提示填写自己的 HTTPS 入口、从该入口网页生成的 10 分钟一次性配对码和设备名称；没有已配置桥接时，需要明确选择一个现有普通本机会话作为启动身份。桌面离线或身份有歧义时会停止，不消费配对码。

ZIP 安装器优先使用已有 Node.js 22.16+，否则下载官方 Windows x64 运行时并验证 SHA-256，保存到包内 `.local/tools`，不改系统 PATH。包内已有 ws，无需手动下载 npm 运行依赖。安装目录随后不要移动，电脑重新登录 Windows 后再打开 Codex，连接器会恢复；详细恢复条件见 [VPS 方案](vps-device-hub.md#windows-首次安装与再次启动)。
