# Codex Mobile Bridge

Codex Mobile Bridge 可让你通过手机浏览器查看和继续 Windows 电脑上正在运行的 Codex 会话。电脑连接器连接本机 Codex，手机网页通过 HTTPS 服务访问已绑定的电脑；不需要在网页填写模型 API 密钥。

**稳定版 v1.0.0** 已提供 Windows x64 连接器和 VPS 服务包。普通用户只需 Windows x64 电脑和管理员提供的 HTTPS 入口与邀请；需要独立服务的用户可自行部署 VPS。

## 下载 v1.0.0

| 文件 | 用途 |
| --- | --- |
| [CodexMobileConnector-Setup.exe](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/CodexMobileConnector-Setup.exe) | Windows x64 图形安装器，普通用户推荐 |
| [codex-mobile-connector-windows.zip](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/codex-mobile-connector-windows.zip) | Windows x64 终端安装备用包 |
| [codex-device-hub.tar.gz](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/codex-device-hub.tar.gz) | VPS 服务与部署脚本 |
| [SHA256SUMS](https://github.com/GengsengGhou/codex-mobile-bridge/releases/latest/download/SHA256SUMS) | 三个安装包的 SHA-256 校验清单 |

请从同一 Release 下载所需文件和校验清单，并在安装前核对 SHA-256。Release 下载不需要 GitHub 令牌，也不会自动创建服务账号。

## 选择使用方式

- **使用已有服务**：向管理员私下索取 HTTPS 入口网址和一次性邀请，按[快速开始](docs/quick-start.md)注册账号并绑定电脑。邀请用于注册账号；网页生成的一次性配对码用于绑定连接器，二者不能互换。
- **自行部署服务**：准备 Ubuntu / Debian VPS、域名和可用的 HTTPS，按[原生部署教程](docs/native-vps-deployment.md)操作；已有 Docker Engine 的用户也可参考[Compose 部署](docs/compose-deployment.md)。
- **临时访问单台电脑**：源码用户可用[临时 HTTPS 手机访问](docs/temporary-mobile-access.md)，无需 VPS 或自有域名；隧道地址会变化，不适合作为长期入口。

连接器应安装在运行 Codex 的 Windows x64 电脑上。使用时用户需要已登录 Windows，电脑需要开机并联网，Codex 桌面和连接器需要运行。首次安装、邀请注册、配对、升级和排错步骤见[快速开始](docs/quick-start.md)与[Windows 安装说明](docs/windows-installer.md)。

## 能做什么

通过手机网页查看普通 Codex 会话、历史消息和运行状态，继续发送消息，处理已支持的审批与问题，选择下一轮模型和推理强度，并查看或下载当前会话工作目录中允许访问的文件。可选 VPS Hub 支持多用户、设备配对和设备撤销。详情见[功能与服务结构](docs/vps-device-hub.md)及[文档索引](docs/README.md)。

## 兼容与安全边界

- 本项目是非官方客户端，依赖 Codex 桌面的内部接口；这些接口没有稳定性承诺，桌面升级后可能需要更新适配，不能保证兼容未来桌面版本。
- VPS Hub 是受信任的中转服务，会处理经过它的请求与内容。本方案不是端到端加密；不要把不可信运营者的服务用于敏感会话。默认不会把聊天正文和文件内容持久化到 VPS。
- Windows 电脑离线、Codex 未运行或连接器未连接时，网页无法继续该电脑上的会话。登录前控制、自动启动 Codex、睡眠唤醒和断电恢复不在支持范围内。
- 实体手机、第二台实际电脑和未来 Codex 桌面版本的兼容情况，以[验收记录](docs/verification.md)中明确记载的验证范围为准。

源码仓库：[GengsengGhou/codex-mobile-bridge](https://github.com/GengsengGhou/codex-mobile-bridge)。维护者和开发者请从[开发与架构文档](docs/README.md#开发者)开始。

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

首次启动会把任务关联、端口和发送范围保存在忽略版本控制的 `.local/runtime.json`。此后可从项目目录运行 `npm run start:background`，无需重新选择任务。本地页面默认位于 `http://127.0.0.1:4317/`。测试与只读探针说明见[验收记录](docs/verification.md)和各功能文档；协议集成边界见[协议记录](docs/protocol-notes.md)。
