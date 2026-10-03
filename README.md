# Codex Mobile Bridge

电脑上的 Codex 正在处理一项工作时，你可以离开桌前，用手机浏览器打开同一个会话查看进度、补充消息或处理支持的请求；电脑继续负责实际执行任务。

Windows 连接器运行在 Codex 所在电脑上，连接本机桌面并主动连到 HTTPS Hub。Hub 为网页登录、账号邀请、设备配对和请求转发提供统一入口。管理员邀请用于注册账号；用户登录后生成的一次性配对码用于绑定电脑，两者不能互换。网页沿用桌面配置的模型和提供方，不需要填写模型 API 密钥。

当前正式稳定版为 v1.0.3，修复部分会话切换时的读取失败，并保留单会话错误发生时的健康设备连接。

## 下载

| 文件 | 用途 |
| --- | --- |
| [CodexMobileConnector-Setup.exe](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/CodexMobileConnector-Setup.exe) | Windows x64 图形安装器，普通用户推荐；内置 Node.js 和连接依赖 |
| [codex-mobile-connector-windows.zip](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/codex-mobile-connector-windows.zip) | Windows x64 终端安装备用包 |
| [codex-device-hub.tar.gz](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/codex-device-hub.tar.gz) | VPS Hub 服务与部署脚本 |
| [SHA256SUMS](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/SHA256SUMS) | 三个安装包的 SHA-256 校验清单 |

安装前从同一 Release 下载软件包和 `SHA256SUMS`，核对文件哈希。公开下载无需 GitHub 令牌，也不会自动创建服务账号。Windows 需要 WebView2 Runtime；缺少时按连接器提示安装微软官方运行时。

## 首次使用

1. 选择入口：已有服务的用户向管理员私下索取 HTTPS 网址和一次性邀请；自行部署者先按[原生 VPS 部署](docs/native-vps-deployment.md)或[Docker Compose 部署](docs/compose-deployment.md)配置 Hub、HTTPS 和管理员。
2. 在运行 Codex 的 Windows x64 电脑上安装连接器。普通用户使用 EXE；ZIP 供需要终端安装的用户使用。
3. 在电脑上打开连接器，填写管理员提供的 HTTPS 网址，并打开浏览器登录。新用户用管理员邀请注册账号，再登录该入口。
4. 在网页中打开“添加设备”，生成一次性配对码；回到连接器，填写设备名称和配对码，完成电脑绑定。
5. 在手机浏览器打开同一个 HTTPS 网址，登录后选择已配对电脑，再打开要继续的会话。

电脑使用时必须开机、联网并已登录 Windows，Codex 桌面和连接器都要运行。完整配对、升级和排错步骤见[快速开始](docs/quick-start.md)与[Windows 安装说明](docs/windows-installer.md)。

## 使用方式

- **使用管理员提供的服务**：不需要自己的 VPS 或域名。管理员负责 Hub 和账号邀请；你负责安装连接器并配对自己的电脑。
- **自行部署 VPS**：准备 Ubuntu / Debian VPS、域名和可用 HTTPS；管理员邀请用户，每位用户配对并访问自己的电脑。
- **源码临时访问**：开发者可通过 [Quick Tunnel 临时访问单台电脑](docs/temporary-mobile-access.md)，无需 VPS 或自有域名；临时 URL 会变化，不适合作为长期入口。

## 功能

- 查看会话、历史消息和运行状态；按文本搜索，并按项目、置顶和自定义顺序浏览会话。
- 创建会话、重命名、归档和恢复；发送消息或向运行中的会话补充消息。
- 处理支持的问题和审批，查看交互状态，或停止当前运行。结果不明时查询回执，不自动重发。
- 为下一轮选择模型、推理强度和权限；运行中补充消息沿用当前轮的设置。
- 上传附件；在会话工作目录允许的范围内浏览文件、预览文本/图片/PDF，并下载文件。
- 使用 Markdown、代码复制和 KaTeX 公式；中英文界面、10–48 px 字号与可折叠的工作过程展示。
- Hub 支持多账号、多台已配对电脑及设备撤销；连接器提供托盘状态、登录后自动连接和保留配对的重连。

Windows 连接器的设置页提供自动检查更新、手动检查和“下载并升级”：下载经过校验后打开安装器，由你确认升级。详情见 [Windows 安装说明](docs/windows-installer.md)。

页面以轮询快照同步状态，不提供逐 token 实时流。子智能体内容仅供只读查看。文件访问受会话工作目录和类型/大小限制约束，不等同于任意远程磁盘访问。

## 兼容与安全边界

本项目是非官方客户端，依赖 Codex 桌面的内部接口；这些接口没有稳定性承诺，桌面升级后可能需要更新适配。Hub 是受信任的中转服务，会处理经过它的请求与内容；系统不提供端到端加密，默认不持久化聊天正文或文件内容。只在你信任的服务上登录和配对。

这不是远程桌面：电脑离线、用户未登录 Windows、Codex 未运行或连接器未连接时，手机无法继续会话。产品不支持登录 Windows 前控制、自动启动 Codex、睡眠唤醒或断电恢复。实际验证范围见[验收记录](docs/verification.md)，部署与信任边界见[服务结构说明](docs/vps-device-hub.md)。

文档索引见[docs/README.md](docs/README.md)。源码仓库：[GengsengGhou/codex-mobile-bridge](https://github.com/GengsengGhou/codex-mobile-bridge)。

## 开发者

源码开发需要 Node.js 22.16 或更新版本。在已运行 Codex 桌面的电脑上克隆仓库并安装依赖。`npm ci` 和 `npm test` 可在普通终端执行：

```powershell
npm ci
npm test
```

首次启动 `npm start` 必须从 Codex 桌面任务环境运行，以便记录该任务关联；不要手动填写任务 ID。发送默认关闭，保留默认值时服务仅提供只读访问。需要向全部本机会话发送时，在该 Codex 任务终端明确开启：

```powershell
$env:BRIDGE_ENABLE_SEND = '1'
$env:BRIDGE_SEND_SCOPE = 'all-local'
npm start
```

首次启动会把任务关联、端口和发送范围保存在忽略版本控制的 `.local/runtime.json`。此后可从项目目录运行 `npm run start:background`，无需重新选择任务。本地页面默认位于 `http://127.0.0.1:4317/`。测试与只读探针说明见[验收记录](docs/verification.md)，协议集成边界见[协议记录](docs/protocol-notes.md)。
