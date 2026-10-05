# 文档索引

## 用户

- [快速开始](quick-start.md)：下载、校验、邀请注册、Windows 配对和常见问题。
- [临时 HTTPS 手机访问](temporary-mobile-access.md)：源码版通过短期隧道访问单台电脑。
- [Windows 安装说明](windows-installer.md)：安装器、升级、卸载和备用 ZIP。
- [语言设置](languages.md)、[模型设置](model-settings.md)、[数学公式显示](math-rendering.md)、[Mermaid 图表](mermaid-rendering.md)：使用细节。
- [验收记录](verification.md)：按日期记录已执行的测试和未覆盖范围。

## 服务管理员

- [VPS Hub 结构与权限边界](vps-device-hub.md)：账号、设备配对、连接结构及信任边界。
- [原生 VPS 部署](native-vps-deployment.md)：Ubuntu / Debian 首次安装、升级、备份和排错。
- [Docker Compose 部署](compose-deployment.md)：适用于已配置 Docker 的 VPS。
- [Hub 资源与保留策略](hub-resource-limits.md)：运行限制、数据保留和发布激活说明。

## 功能与兼容说明

- [远程使用条件](remote-readiness.md)：电脑状态、连接恢复和各项能力的验证状态。
- [会话上下文与权限](thread-context-permissions.md)：上下文展示及下一轮权限覆盖。
- [历史与会话同步](history-sync.md)、[侧栏排序](desktop-sidebar-order.md)：会话列表与历史行为。
- [上传存储](upload-storage.md)：按工作目录配置附件位置、迁移与文件访问边界。
- [Hub 前端](hub-frontend.md)：服务页面结构。
- [Codex App Server 协议记录](protocol-notes.md)：已安装 CLI 的只读协议探查及其局限。

## 开发者

源码运行和项目命令见仓库根目录 [README](../README.md#开发者)。协议与边界信息见[协议记录](protocol-notes.md)。本仓库不公开机器本地 `.local/`、`work/`、`dist/` 或 `docs/verification/` 中的生成文件和运行证据。
