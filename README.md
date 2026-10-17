# Codex Mobile Bridge

用手机浏览器查看并继续电脑上的 Codex 会话，任务仍由运行 Codex 的 Windows 电脑执行。

## 功能

- 浏览项目、会话、历史消息和运行状态，并搜索、置顶或整理会话。
- 新建或继续会话、发送消息、处理支持的问题与审批，并停止当前运行。
- 为下一轮选择模型、推理强度和权限；运行中补充消息沿用当前设置。
- 在会话工作区内浏览、预览和下载文件，也可上传附件。
- 可选电脑协作：经目标电脑明确授权后，从另一台配对电脑派发任务。
- 支持 Markdown、公式、Mermaid 图表及中英文界面。

## 下载

正式发布资产为 Windows x64 图形安装器 `CodexMobileConnector-Setup.exe`、Hub 部署包 `codex-device-hub.tar.gz` 和 `SHA256SUMS`；清单校验两个安装产物。该版本不发布 Windows ZIP；v2.0.0 ZIP 是历史资产。普通用户推荐从[最新发行页面](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest)下载图形安装器，它内置 Node.js 和连接依赖；Windows 需要 WebView2 Runtime，缺少时按提示安装。VPS 管理员从同一发行版下载 Hub 包与校验清单。

安装前从同一 Release 下载 `SHA256SUMS` 并核对文件哈希。安装包未签名，Windows 可能显示发布者或信誉提示。

## 开始使用

1. 使用管理员提供的 HTTPS 地址和一次性邀请注册账号，或先按[部署指南](docs/native-vps-deployment.md)自行准备 Hub。
2. 在运行 Codex 的 Windows x64 电脑上安装并打开连接器，输入 HTTPS 地址，在浏览器登录。
3. 登录后在 Hub 生成一次性电脑配对码，回到连接器输入设备名称和配对码。
4. 保持电脑和连接器运行；手机浏览器打开同一 HTTPS 地址，登录后选择电脑和会话。

## 使用条件与权限

电脑必须开机、联网并已登录 Windows，Codex 桌面和连接器都要运行。Hub 会中转请求和内容，因此只使用可信服务；本项目不提供端到端加密。这是非官方工具，Codex 桌面更新后可能需要适配。电脑协作需目标端明确授权来源设备和项目，任务使用目标电脑的本地 Codex 权限，不会自动批准操作或提供任意文件访问。模型提供方和 API 密钥保留在各自电脑。

配对、修复和排错见[快速开始](docs/quick-start.md)与[Windows 安装说明](docs/windows-installer.md)；从 v2.0.1 升级仅需在原目录运行新版安装器，现有 Hub 可继续使用；更早版本的时钟兼容升级见[2.0.1 升级指南](docs/upgrading-2.0.1.md)；VPS 管理员见[部署指南](docs/native-vps-deployment.md)；其他文档和开发验证见[文档索引](docs/README.md)。

Windows EXE 图形版（v2.0.1 起）支持在可信的 v2.0.1 Hub 提供服务器时间时，兼容错误的 Windows 系统日期；Hub 时间必须准确。旧版 Hub 在客户端系统时间正确时仍可连接。时钟兼容依赖 EXE 内的 `CertificateVerifier.exe`；v2.0.0 历史 ZIP 不含此 helper，但系统时间正确时仍可使用。兼容范围是连接器与 Hub 的 HTTPS、WSS 和 MCP 通信，不改变 Windows 系统时间，也不保证 Codex 登录或模型提供方的直接请求在错误系统时间下可用。
