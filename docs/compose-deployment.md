# Docker Compose 部署

这是独立的部署方案，适合已有 Docker Engine 与 Compose 插件的新 VPS。普通新服务器优先使用 [原生 Ubuntu / Debian 教程](native-vps-deployment.md)。不要在同一台服务器同时执行两种安装，也不要让容器 Caddy 抢占已有网站的 80/443 端口。

## 前置条件与文件

- Ubuntu / Debian，已有可正常使用的 Docker Engine、`docker compose` 和 `iproute2`。Docker 安装请遵循对应发行版的 [官方说明](https://docs.docker.com/engine/install/)，不要把系统的 `docker.io` 与官方 Docker 包混装。
- 有自己的域名，DNS A 记录指向 VPS；只有服务器 IPv6 可访问时才配置 AAAA。放行入站 TCP 80/443，允许 HTTPS 出站。示例 `codex.example.com` 必须替换为自己的域名。
- 80/443 没有已有监听服务。安装脚本遇到占用会停止，不会替换已有代理；已有代理整合需要自行审查，不能直接照此执行。
- 已按照 [下载与校验](quick-start.md#下载与校验) 获取服务器 tar.gz 和 `SHA256SUMS`。公开 Release 可直接下载，也可浏览器下载后上传 VPS；直接下载命令见 [原生教程](native-vps-deployment.md#3-下载上传并校验服务器包)。

以下命令在 VPS 的 root shell 执行，仅适用于首次部署；先把两个下载文件上传到 `/root/codex-hub-release/`。

```bash
cd /root/codex-hub-release
grep '  codex-device-hub.tar.gz$' SHA256SUMS | sha256sum --check -
docker compose version
docker info
ss -ltn '( sport = :80 or sport = :443 )'
```

校验必须显示 `codex-device-hub.tar.gz: OK`。确认端口未占用后，在新的目录解压并安装：

```bash
install -d -m 0755 /opt/codex-mobile-hub-compose
tar -xzf /root/codex-hub-release/codex-device-hub.tar.gz -C /opt/codex-mobile-hub-compose
cd /opt/codex-mobile-hub-compose
bash deploy/install.sh codex.example.com
```

脚本检查 Docker、端口和域名，写入私有权限的 `deploy/.env` 后构建并启动 Hub 与 Caddy 容器。它不安装 Docker、不配置 DNS；Hub 构建仍需连接 npm，Caddy 需签发受信任的 HTTPS 证书。已有 `.env` 时脚本停止，不能用于自动升级。

## 管理员与设备

```bash
cd /opt/codex-mobile-hub-compose/deploy
docker compose exec hub node hub/admin.mjs create-admin admin
```

该命令使用隐藏密码输入；不要加 `-T`，也不要在命令、环境变量或文件中放密码。建议至少 12 个 ASCII 字符，首次初始化只允许数据库中尚无账号时运行。

打开自己的 HTTPS 入口，用管理员登录，在“邀请账户”中生成 24 小时一次性邀请，再按 [受邀使用与设备配对](quick-start.md#受邀使用已有服务) 操作。

## 检查、重启与备份

在 `deploy` 目录执行：

```bash
docker compose ps
docker compose logs --tail=50 hub caddy
curl -fsS https://codex.example.com/healthz
docker compose restart hub
```

健康返回 `{"ok":true}`。日志仅供私下排错，不贴出邀请参数、账号或部署信息。Docker 服务必须开机启动，容器的 `unless-stopped` 策略才可在主机重启后恢复；主动停止的容器需要 `docker compose up -d`。

持久数据在 Compose 的 `hub_data` volume，TLS 证书在 `caddy_data`，配置在 `deploy/.env` 和 Caddyfile。`docker compose down` 默认保留这些 volume；**不要执行 `down -v`**，该操作会删除账号、设备归属和证书数据。数据库使用 WAL，运行中不能只复制一个 `hub.sqlite` 文件。可靠备份应使用 SQLite 备份 API，或在停止 Hub 后备份整个数据 volume；备份文件保存在私有目录，并确认恢复过程可用。此方案未提供自动数据库备份或一键升级。

Compose 配置已验证，但没有运行真实容器端到端验收；原生服务方案有受控部署验收。资源限制见 [Hub 资源策略](hub-resource-limits.md)。
