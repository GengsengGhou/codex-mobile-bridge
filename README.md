# Codex Mobile Bridge

用手机浏览器继续电脑上的 Codex 会话：查看进度、发送消息、处理问题和审批，电脑负责执行任务。

Windows 连接器连接本机 Codex，并通过 HTTPS Hub 为手机提供统一入口。网页沿用桌面的模型和提供方配置，无需填写模型 API 密钥。

## 功能

- 浏览、搜索和管理会话，查看历史与运行状态，创建、重命名、归档和恢复会话。
- 发送消息、运行中补充、停止当前运行，处理支持的问题与审批。
- 为下一轮选择模型、推理强度和权限；运行中补充沿用当前轮设置。
- 上传附件，浏览会话工作目录中的文件，预览文本、图片、PDF 并下载结果。
- 显示 Markdown、代码、数学公式和 Mermaid 图表；支持中英文界面与字号调整。
- 一个账号连接多台电脑；Windows 托盘提供连接状态、登录后自动连接与更新入口。

## 下载

本页对应 **v1.0.0**。从 [v1.0.0 Release](https://github.com/GengsengGhou/codex-mobile-bridge/releases/tag/v1.0.0) 下载软件包与同版校验清单。

| 文件 | 用途 |
| --- | --- |
| [CodexMobileConnector-Setup.exe](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/CodexMobileConnector-Setup.exe) | Windows x64 图形安装器，内置 Node.js 与连接依赖 |
| [codex-mobile-connector-windows.zip](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/codex-mobile-connector-windows.zip) | Windows 终端安装备用包 |
| [codex-device-hub.tar.gz](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/codex-device-hub.tar.gz) | Hub 服务与部署脚本 |
| [SHA256SUMS](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.0/SHA256SUMS) | 安装包 SHA-256 校验清单 |

Windows 需要 WebView2 Runtime；缺少时按连接器提示安装微软官方运行时。下载与校验步骤见[快速开始](docs/quick-start.md)。

## 开始使用

1. 从服务管理员获取 HTTPS 入口和一次性注册邀请；自行部署请先完成[原生 VPS 部署](docs/native-vps-deployment.md)或[Docker Compose 部署](docs/compose-deployment.md)。
2. 在运行 Codex 的 Windows x64 电脑上安装并打开连接器，填写该 HTTPS 入口。
3. 打开网页登录，注册或登录后生成电脑配对码，回到连接器绑定这台电脑。
4. 手机上打开同一个 HTTPS 入口，登录后选择电脑和会话。

使用时电脑需要开机、联网并已登录 Windows，Codex 和连接器都需要运行。登录后自动连接会等待 Codex，不会自动启动 Codex 或唤醒电脑。

邀请用于注册账号，配对码用于绑定电脑，两者不能互换。详细步骤、托盘操作和常见问题见[快速开始](docs/quick-start.md)；升级和卸载见[Windows 安装说明](docs/windows-installer.md)。

## 使用条件

这是非官方客户端，依赖 Codex 桌面的内部接口，桌面升级后可能需要更新适配。页面通过快照轮询同步；子智能体仅支持只读查看。文件访问受会话工作目录、类型和大小限制。

Hub 是受信任的中转服务，会处理经过它的请求与内容，当前不提供端到端加密。请只在你信任的服务上登录和配对，妥善保管邀请和配对信息。

更多使用与部署说明见[文档索引](docs/README.md)。源码运行与构建见[开发指南](docs/development.md)。
