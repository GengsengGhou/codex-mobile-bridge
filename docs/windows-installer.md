# Windows graphical connector

中文下载与首次配对步骤见 [简易配置教程](quick-start.md#配对-windows-电脑)。安装包和 SHA-256 清单见公开的 [发行版本](https://github.com/GengsengGhou/codex-mobile-bridge/releases)，无需 GitHub 令牌或桥接账号即可下载。下面记录安装器细节与构建验证。

Distribute `dist/CodexMobileConnector-Setup.exe` with its published SHA-256 checksum.
The Windows x64 installer embeds the application, its `ws` dependency, and Node.js.
The release build downloads Node.js 22 from the official distribution and verifies
its published SHA-256 before embedding it. No manual Node installation is needed.
The EXE is unsigned; Windows may show publisher reputation information.

Installation uses `%LOCALAPPDATA%\CodexMobileConnector` and a current-user Start menu
shortcut. A successful first pairing enables current-user login recovery unless the user
previously chose to keep it off. Existing saved preferences or verifiable owned startup
entries preserve the automatic choice; an old v0.1.0 uninstall removes startup
entries, so check and select login recovery again after reinstalling.
It does not request administrator rights.
The companion is localized in Chinese. Generate a one-time JSON pairing ticket on the
Hub device page, copy it, and paste it into the companion. The ticket supplies the
HTTPS Hub origin, pairing code, device name, and expiry; the companion validates these
fields before asking you to confirm. No personal server domain is prefilled. Pairing can finish before
Codex is open. Pairing records one-time bootstrap authorization and the selected
login preference in private local state before attempting OS registration. A failed
registration can be retried with “连接” without using the ticket again. Successful
first pairing enables login recovery by default unless the user had already selected
a preference, then launches the independent persistent watcher for this session.
The window can be hidden to the tray while this connection continues.
The watcher waits for Codex and an existing ordinary local conversation, then
saves the verified bridge identity, clears pending bootstrap authorization, and
continues bridge/connector recovery. It never creates or sends a conversation
to bootstrap the connection. The pairing ticket stays in process memory and is never
logged; legacy manual pairing codes are masked and passed through stdin;
device tokens are saved with a current-user-only file ACL.

The companion includes connection status, retry, Open Codex, server settings,
explicit replacement pairing, and uninstall. An expired or rejected replacement
code preserves the previous credentials and connection. A verified replacement
stops only this installation's old connector. Revoke the old device in its original
Hub afterward. Uninstall removes owned app/startup entries and preserves `.local`
pairing and runtime data. Reinstall can reuse that preserved data. Running the
installer over an existing app refuses before overwriting files; use the existing
companion or uninstall while keeping data before reinstalling.

## 托盘、退出与登录启动

首次成功配对默认开启 Windows 登录后自动连接，并立即在托盘等待 Codex。若用户在配对前已明确关闭设置，则沿用关闭状态。

窗口 X 只隐藏窗口，托盘图标仍在，连接不会中断。双击图标或点击托盘“显示窗口”恢复窗口；普通打开窗口不会恢复连接。托盘“连接”明确恢复保存的配对；“断开连接”暂停连接并跨 Windows 登录持久保留，只有再次明确“连接”才会恢复。托盘“退出”停止本安装拥有的恢复监测和连接器，保留配对、配置和数据；不停止独立桥接、Codex 或其任务，也不清理其他安装的进程。本次 Windows 登录内暂停阻止后台重连；下次登录按自动连接设置运行。

登录启动项属于当前用户，不提升权限。首次成功配对默认登记登录后自动连接；配对前明确关闭时不会开启。下次登录以隐藏托盘模式启动并恢复监测。关闭该设置只取消之后的登录自动启动，本次连接仍保持。主动退出不会修改这个设置；若仍为开启，下次登录 Windows 会重新恢复并等待 Codex。跨登录的主动断开优先阻止恢复，即使仍开启自动启动，也需用户再次明确连接。已有新版偏好或可验证本安装拥有的旧登录任务 / 启动项时，保留自动选择并迁移到应用托盘入口，不替换外部程序的入口。旧 v0.1.0 的保留数据卸载会移除其登录入口且未保存独立自动偏好，重装后需重新核对、按需要勾选自动连接开关；不能从身份或配对标记推断此选择。它不支持登录前控制、自动开启 Codex 或睡眠唤醒。

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

`node deploy/verify-connector-tray.mjs` runs the final EXE in an isolated installation
with a local TLS/WSS fixture. It checks owned watcher/connector shutdown, preserved
unrelated Node and independent bridge processes, same-logon pause, actual WinForms
X-hide, tray state, second-instance behavior, and explicit Quit. It exercises the
actual form methods; native mouse clicks on the Windows tray and real login-entry
migration are not claimed. Isolated QA does not modify live pairing or startup entries.

QA overrides do not add login entries or Start menu shortcuts. Evidence is saved
under `docs/verification`, which is excluded from distributable bundles.

Current visual verification uses the running app's `DrawToBitmap` rendering.
Native GUI input and interactive desktop screenshot acceptance were unavailable
because the Windows desktop was locked; no GUI click acceptance is claimed.

## 备用 ZIP 终端安装

下载 `codex-mobile-connector-windows.zip` 并按 `SHA256SUMS` 校验同名项，在自己的用户目录解压。不要放在 EXE 已有安装目录内，也不要混用两个安装目录的 `.local` 数据。

打开 Codex 并确保已有普通本机会话，双击解压目录中的 `deploy/install-connector.cmd`。按终端提示填写自己的 HTTPS 入口、从该入口网页生成的 10 分钟一次性配对码和设备名称；没有已配置桥接时，需要明确选择一个现有普通本机会话作为启动身份。桌面离线或身份有歧义时会停止，不消费配对码。

ZIP 安装器优先使用已有 Node.js 22.16+，否则下载官方 Windows x64 运行时并验证 SHA-256，保存到包内 `.local/tools`，不改系统 PATH。包内已有 ws，无需手动下载 npm 运行依赖。安装目录随后不要移动，电脑重新登录 Windows 后再打开 Codex，连接器会恢复；详细恢复条件见 [VPS 方案](vps-device-hub.md#windows-首次安装与再次启动)。

此高级终端流程仍显式登记 legacy 当前用户登录恢复，属于自动模式；它没有 EXE 的托盘窗口。CLI 监测和连接器也遵守同一安装目录的本次登录暂停状态；不会通过旧登录入口绕过图形应用主动退出。
