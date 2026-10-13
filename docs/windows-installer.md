# Windows 安装与更新

适用于 Windows x64。推荐使用 [v1.0.0 安装器](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/CodexMobileConnector-Setup.exe)，并对照同版 [SHA256SUMS](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/SHA256SUMS) 校验。完整配对步骤见[快速开始](quick-start.md#配对-windows-电脑)。

## 安装与配对

安装到当前用户，不需要管理员权限或手动安装 Node.js。安装器内置 Node.js 和连接依赖；缺少 WebView2 Runtime 时按提示安装微软官方运行时。

选择界面语言并安装，然后填写 HTTPS 服务入口，打开网页登录。管理员邀请用于注册；登录后生成的一次性配对码用于绑定电脑。Codex 可以稍后打开，连接器会等待可用的普通本机会话。

通过桌面或开始菜单的“Codex Mobile Bridge”打开窗口。设置页可切换中英文；配对与运行配置保存在安装目录的私有 .local 数据中，安装目录不要移动。

## 托盘与自动连接

- 窗口 X 隐藏到托盘，连接继续；双击托盘图标恢复窗口。
- “连接”恢复保存的配对；“断开连接”持续暂停，Windows 重新登录后也需明确连接。
- “退出”停止本安装的连接器和监测，保留配对。本次 Windows 登录内暂停，下次登录按自动连接设置运行。
- 首次成功配对默认开启登录后自动连接；配对前明确关闭时保留关闭选择。该设置只控制连接器，Codex 仍需自行打开。

## 更新与卸载

设置页提供自动检查更新、手动检查和“下载并升级”。发现更高版本后，下载经过校验再打开安装器，由你确认升级。检查失败不会阻止当前连接；也可从项目 Release 手动下载新版与同版校验清单。

新版安装器会原位升级已确认归属的旧安装，保留配对、运行配置、语言、自动连接选择和主动断开状态。安装失败时尝试回退；发生恢复错误时保留备份位置供处理。相同或更旧版本拒绝覆盖，不要在待确认操作期间升级。

通过 Windows 已安装应用卸载。卸载移除本安装拥有的程序、快捷方式和登录启动项，保留 .local 配对及数据，重新安装到原目录可继续使用。更换服务时明确替换配对，并在原服务撤销旧设备。

## 备用 ZIP 终端安装

下载并校验 [v1.0.0 ZIP](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/codex-mobile-connector-windows.zip)，解压到自己的用户目录，不要与 EXE 安装目录混用。

打开 Codex 并确保已有普通本机会话，运行 deploy/install-connector.cmd，按提示填写 HTTPS 入口、配对码和设备名称。首次初始化需要明确选择一个普通本机会话。此流程使用当前用户登录恢复，没有 EXE 托盘界面。

ZIP 优先使用已有 Node.js 22.16+，否则下载并校验官方运行时；包内已含 ws。升级与卸载分别使用 deploy/upgrade-connector.ps1 和 deploy/uninstall-connector.ps1。详细参数请查看脚本帮助。
