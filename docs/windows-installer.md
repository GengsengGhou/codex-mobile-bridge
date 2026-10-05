# Windows graphical connector

中文下载与首次配对步骤见 [简易配置教程](quick-start.md#配对-windows-电脑)。v1.0.4 安装包和 SHA-256 清单可从[最新稳定版 Release](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest)下载，无需 GitHub 令牌或桥接账号。下面记录安装器细节与构建验证。

Distribute `dist/CodexMobileConnector-Setup.exe` with its published SHA-256 checksum.
The Windows x64 installer embeds the application, its `ws` dependency, Node.js,
and the managed WebView2 SDK assemblies and x64 native loader. The WebView2 SDK
is pinned by version and SHA-256 in `deploy/windows/webview2-sdk.json`; its license
is included. Microsoft Edge WebView2 Runtime is supplied by Windows/Edge. When
it is absent, a native recovery window opens Microsoft's official installer
download. Setup and cold uninstall work without WebView2 or SDK assemblies.
The desktop shell uses .NET Framework 4.8 and per-monitor DPI V2.
The release build downloads Node.js 22 from the official distribution and verifies
its published SHA-256 before embedding it. No manual Node installation is needed.
The EXE is unsigned; Windows may show publisher reputation information.

Installation uses `%LOCALAPPDATA%\CodexMobileConnector` and current-user Start menu
and desktop shortcuts named `Codex Mobile Bridge`. Search Start for `Codex Mobile Bridge`.
Setup and upgrades create both shortcuts; ordinary app launches repair only the Start menu
entry, so deleting the desktop shortcut is respected until the next install or upgrade.
Owned legacy `Codex Mobile Connector` and `Codex 手机桥接` shortcuts are migrated, and uninstall removes only
shortcuts targeting this installation with its working directory and no arguments.
The executable has an application filename and English product metadata; shortcuts and
the running process share the stable AppUserModelID `CodexMobileBridge.Connector`.
A successful first pairing enables current-user login recovery unless the user
previously chose to keep it off. Existing saved preferences or verifiable owned startup
entries preserve the automatic choice; an old v0.1.0 uninstall removes startup
entries, so check and select login recovery again after reinstalling.
It does not request administrator rights.
The installer and app support Chinese and English. Select the language before
installation, or change it afterward in Settings. See [language settings](languages.md).
Enter the server address (a plain hostname
is normalized to HTTPS) and open login in the system browser. Log in or register
with an invitation there, generate a one-time code, and enter it with this
computer's name in the desktop window. Server, name and masked 43-character code
fields are always visible during onboarding. A validated full JSON ticket can
also be imported from the clipboard into those fields; importing never pairs
automatically. No personal server domain is prefilled. Pairing can finish before
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
logged; pairing codes are masked and passed through stdin;
device tokens are saved with a current-user-only file ACL.

The companion includes separate server and verified local Codex availability,
connect/disconnect/retry, Open Web, Open Codex, settings and diagnostics,
explicit replacement pairing, and uninstall. An expired or rejected replacement
code preserves the previous credentials and connection. A verified replacement
stops only this installation's old connector. Revoke the old device in its original
Hub afterward. Uninstall removes owned app/startup entries and preserves `.local`
pairing and runtime data. Reinstall can reuse that preserved data. Running the
newer installer over a verified older installation shows Upgrade and replaces the
application in place. Setup checks `installed.json` root/schema and the installed
EXE version before stopping only this installation's GUI, watcher, connector and
bridge processes. It keeps `.local`, automatic-login preference and explicit
disconnect intent. A manually started connection resumes even when automatic login
is off. A failed upgrade restores the previous application files and attempts to
resume the previous connection. An interrupted upgrade keeps a transaction journal
and backup beside the installation; rerunning Setup restores that transaction first.
If restoration itself fails, Setup reports the retained backup path for recovery.
Equal or older Setup versions and directories whose
ownership cannot be verified are refused. One owner per
installation/user handles repeated app launches; repeated Setup launches for
the same destination also wake one installer. Independent installations retain
their own state and identity.

The installed interface is local HTML/CSS/JavaScript hosted by WebView2. Native
C# owns setup, tray, lifecycle and a validated command bridge. Only bundled local
assets can load in the embedded browser. External navigation, new windows,
downloads, permissions and host objects are blocked; password autosave and form
autofill are disabled. There is no desktop control
HTTP server. Passive polling uses its own read guard and action epoch, never
disables inputs or replaces drafts, and defers during mutations/confirmation.
Initialization blocks mutations until intent is read while preserving editable
inputs and browser handoff. Uninstall is gated centrally during pending mutations.

## 检查更新与原位升级

“设置”提供“自动检查更新”“检查更新”和“下载并升级”。自动检查默认开启，在启动与托盘运行期间按节流策略检查 GitHub 最新稳定版：正常检查间隔为 24 小时，检查失败后的自动重试间隔为 1 小时。手动检查可用于立即重试，即使自动检查已关闭；网络失败不会阻止当前连接器工作。检查版本不会改变配对、连接意图或登录启动设置，也不会自动执行升级。

发现更高版本后，点击“下载并升级”。程序从官方项目 Release 下载 EXE 与校验清单，校验文件后打开原位安装界面，由你确认升级。不要在有待确认操作时开始升级；升级过程保留本机配对、运行配置、语言、登录启动偏好和主动断开状态。下载或校验失败不会启动安装器；仍可从最新 Release 手动下载并校验 EXE。

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
and token-free status with isolated fixture Hub responses. Desktop DOM tests also
cover focus/selection/drafts, optional import, duplicates and partial recovery. Run
`node deploy/verify-windows-installer.mjs` after building to execute the actual EXE
in a temporary installation, run its bundled Node, capture its actual WebView2
surface, check same-version rerun refusal, and uninstall while preserving fixture data.
`node deploy/verify-windows-upgrade.mjs <new-setup.exe> <old-setup.exe> [another-old-setup.exe]`
uses isolated roots to check real older package upgrades, preserved data, persistent
disconnect, partial-copy rollback, interrupted transaction recovery, linked `.local`
rejection and an active manually connected v0.1.6 watcher. The TLS fixture uses a
private test CA: watcher and connector process restart is checked automatically;
WSS reconnection is checked with that CA injected into a direct connector process.
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

`node deploy/windows/verify-webview-ui.mjs <setup.exe> <output-directory>` drives
the installed WebView2 surface with isolated CDP input. It checks slow polling,
initialization guards, browser handoff, Enter/duplicates, failures/retries,
replacement drafts, assets, responsive bounds and native DPI/browser pixel ratio.
It records browser-engine input separately from physical Windows keyboard input.
Simulated device scales do not change or prove OS monitor DPI transitions.
`node deploy/windows/verify-bootstrap.mjs <setup.exe> <output-directory>` checks
actual setup/app single-instance wake, missing-runtime/SDK recovery, and cold
uninstall cancellation/removal while preserving data. Its injected fixture
confirmation does not claim native clicks. `DrawToBitmap` is used only for native
recovery dialogs; the main interface uses WebView2 captures. The filled tray icon
can be regenerated with `deploy/windows/generate-icons.mjs --brand-only` and a
maintainer-only resvg installation. Its ICO includes 16/20/24/32/48/64/256px images.

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/verify-windows-shortcuts.ps1`
checks the built EXE metadata and real COM shortcut lifecycle in temporary folders: identity,
owned migration, install/upgrade creation, launch deletion preference, conflict preservation
and owned uninstall cleanup. It does not modify live shortcuts or prove Windows search indexing.

QA overrides do not add login entries or Start menu shortcuts. Isolated debug and
capture runs suppress tray icons, except explicit lifecycle/tray acceptance.
Evidence is saved under `work` or `docs/verification`; neither enters release
bundles. Physical keyboard, native tray clicks and real monitor transitions require
an unlocked desktop and are recorded separately from deterministic fixtures.

## 备用 ZIP 终端安装

下载 `codex-mobile-connector-windows.zip` 并按 `SHA256SUMS` 校验同名项，在自己的用户目录解压。不要放在 EXE 已有安装目录内，也不要混用两个安装目录的 `.local` 数据。

打开 Codex 并确保已有普通本机会话，双击解压目录中的 `deploy/install-connector.cmd`。按终端提示填写自己的 HTTPS 入口、从该入口网页生成的 10 分钟一次性配对码和设备名称；没有已配置桥接时，需要明确选择一个现有普通本机会话作为启动身份。桌面离线或身份有歧义时会停止，不消费配对码。

ZIP 安装器优先使用已有 Node.js 22.16+，否则下载官方 Windows x64 运行时并验证 SHA-256，保存到包内 `.local/tools`，不改系统 PATH。包内已有 ws，无需手动下载 npm 运行依赖。安装目录随后不要移动，电脑重新登录 Windows 后再打开 Codex，连接器会恢复；详细恢复条件见 [VPS 方案](vps-device-hub.md#windows-首次安装与再次启动)。

此高级终端流程仍显式登记 legacy 当前用户登录恢复，属于自动模式；它没有 EXE 的托盘窗口。CLI 监测和连接器也遵守同一安装目录的本次登录暂停状态；不会通过旧登录入口绕过图形应用主动退出。
