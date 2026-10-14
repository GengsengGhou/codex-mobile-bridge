# v2.0.1 升级指南

本指南适用于从 v2.0.0 升级到 v2.0.1。发布资产只有 Windows 图形安装器 `CodexMobileConnector-Setup.exe`、Hub 部署包 `codex-device-hub.tar.gz` 和 `SHA256SUMS`；清单校验两个安装产物。v2.0.1 不发布 Windows ZIP，v2.0.0 ZIP 是历史资产。

本版修复 Microsoft Store Codex 可能读取连接器旧副本的问题，并让 Windows EXE 连接器在 Hub 提供可信服务器时间时兼容错误的本机系统日期。升级顺序是先 Hub，再更新参与协作的 Windows 电脑。

## 升级前

确认实际部署方式、服务名、应用目录、数据库位置、运行用户、环境配置、Compose 项目名和数据卷。下文的目录名、服务名、卷名及命令均是仓库标准安装方式的示例；先在自己的服务器核对，不要直接套用到已有网站或不同部署上。

选择没有进行中转发、待确认审批或结果未知的时间窗口。记录当前应用版本及启动方式，并按自己的部署方式备份数据库、环境配置和 TLS/反向代理配置。保留当前应用代码以便回滚。数据库和配置包含私有账号、设备或服务信息，备份应置于权限受限的位置。

## 1. 升级 Hub

从 [v2.0.1 Release](https://github.com/GengsengGhou/codex-mobile-bridge/releases/tag/v2.0.1) 下载 `codex-device-hub.tar.gz` 和同一发行版的 `SHA256SUMS`，按[下载与校验](quick-start.md#下载与校验)中的方法核对 Hub 包哈希。不要从其他版本混用文件。

### 原生 systemd 安装

标准安装示例使用 `/opt/codex-mobile-hub/app` 保存代码、`/var/lib/codex-mobile-hub` 保存数据库、`/etc/codex-mobile-hub.env` 保存环境配置，服务名为 `codex-mobile-hub`。先检查本机 service unit 和 `HUB_DB_PATH`，以实际值为准。

停止本项目 Hub 和维护 timer，在服务停止后备份数据库及 sidecar 文件、环境配置和 Caddy 站点配置。将新包解压到同一文件系统上的临时应用目录，保留旧代码目录；确认包内容和权限后，再按当前服务的实际启动路径替换应用代码。保留原数据库、环境变量、域名、证书、运行用户和服务参数，不重新初始化管理员或设备。

`deploy/native-install.sh install` 仅用于首次安装，会拒绝已有应用或配置；不要用它覆盖升级。启动原服务和维护 timer，使用原公网域名检查 Hub 健康状态，再确认现有设备能连接。原生部署细节见[Ubuntu / Debian VPS 部署](native-vps-deployment.md)。

若升级后检查失败，停止服务并恢复旧应用代码及原服务设置，再启动服务。常规代码回滚保留当前数据库和环境配置；只有确认发生数据库损坏时，才按独立数据库恢复流程处理。

### 现有 Docker Compose 部署

先核对现有 Compose 文件位置、项目名、服务名、`.env`、`hub_data` 和 TLS 数据卷。`codex-device-hub`、`hub_data` 与 `caddy_data` 是仓库示例名称，实际环境可能不同。升级时使用原项目名和原持久卷，避免在新目录意外创建空卷。

按现有部署流程备份数据库和配置，然后用 v2.0.1 Hub 包中的应用文件更新 Hub 构建目录，并仅重建/更新 Hub 服务；保留现有 `.env`、Compose 项目名、数据库及 Caddy 配置和证书卷。确认 Hub 健康、原账号可登录、现有设备在线。

首次安装脚本 `deploy/install.sh` 会拒绝已存在的 `.env`，不能作为升级程序。回滚时用原应用代码重建原 Hub 服务，并继续挂载同一数据卷。不要运行 `docker compose down -v`，不要删除或重新创建数据卷，也不要重新初始化账号。Docker Compose 部署细节见[部署说明](compose-deployment.md)。

## 2. 更新 Windows 电脑

Hub 升级并通过健康检查后，在参与电脑协作的两台 Windows 电脑上分别更新连接器。使用原先安装的 EXE 图形版及其**原安装目录**运行 v2.0.1 安装器并覆盖升级/修复。若是历史 ZIP 或其他目录中的连接器，先确认当前实际使用的安装位置；不要复制 `.local`、设备令牌或迁移旧目录来代替升级。

每台电脑升级完成后打开连接器并点击 **连接**。升级会保留配对、电脑协作授权、项目选择、回执、暂停状态和受支持的工具设置，不需要重新配对。暂停状态会保留，因此要明确点击“连接”恢复运行。然后完全退出并重新打开 Codex，使其重新载入协作连接。已经手动删除或禁用的工具连接不会因升级而重新开启。

Microsoft Store Codex 曾可能使用连接器旧副本。用 EXE 图形安装器在原安装目录修复后，连接器与协作连接会使用同一份状态；无需清理 Codex 缓存或重置配对。更多信息见[Windows 安装说明](windows-installer.md)和[电脑协作](computer-collaboration.md)。

## 时钟兼容范围

系统时间正确的客户端仍可连接旧版 Hub。若 Windows 系统日期错误，需要使用 v2.0.1 Hub；Hub 自身系统时间必须正确，HTTPS 证书必须有效且域名匹配，反向代理也须正常转发 Hub 的 HTTPS、WSS 及可信时间验证请求。请管理员先检查服务器时间、证书和域名。

时钟兼容依赖 Windows EXE 内的 `CertificateVerifier.exe`。历史 ZIP 不含此组件，只能在系统时间正确时使用。兼容范围是连接器与 Hub 之间的 HTTPS、WSS 和 MCP 通信；它不会更改 Windows 系统时间，也不保证 Codex 登录或模型提供方的直接请求能在错误系统时间下运行。

## 完成检查

确认 Hub 健康、原账号和设备数据仍在、两台连接器均显示已连接，并在 Codex 中确认协作连接可用。再按原授权范围做一次无副作用的状态读取。不要为了验证升级而重发结果未知的任务、审批或消息。
