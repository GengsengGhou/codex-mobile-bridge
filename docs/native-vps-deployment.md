# Ubuntu / Debian VPS 部署

在自己的 VPS 上运行入口，自己的 Windows 电脑主动连接入口。以下为 **首次安装**，面向使用 systemd 的 Ubuntu / Debian、x86_64 或 ARM64 主机。所有域名和地址都是示例，替换为自己的值；不会用到运营者的实际 VPS 地址。

脚本负责独立 Node.js 运行时、Hub、systemd 单元及一个 Caddy 站点，不负责购买 VPS、设置 DNS 或安装 Caddy，也不是一键升级程序。已有 Hub 安装、4319 被占用或域名已出现在 Caddy 配置中时会停止，不能靠删除旧数据强行继续。

## 1. 准备域名与网络

在域名服务商处为自己的入口创建 DNS A 记录，例如 `codex.example.com`，指向 VPS 公网 IPv4。只有 VPS IPv6 已配置并能从公网访问时才加 AAAA，错误 AAAA 会导致证书或客户端连接失败。若使用 Cloudflare DNS，首次部署推荐 DNS-only，避免增加代理排错变量。

在云防火墙 / 安全组放行入站 TCP 80 与 443；SSH 使用自己的管理端口。VPS 还需要能通过 HTTPS 访问 Caddy 软件源、nodejs.org、npm registry 和证书签发服务。不开放 4319；电脑端也不开放 4317/4318 或路由器端口。

下面命令仅用于新 VPS。已有网站或代理时，先核对监听和现有配置，保留已有 Caddy；不要重复安装其他代理或覆盖 Caddyfile。使用自己的 SSH 地址登录：

```bash
ssh root@VPS_IP
```

`VPS_IP` 替换为自己的 IP。非 root 用户可先用 `sudo -i` 进入 root shell。安装器检查当前用户必须为 root；容器中没有 systemd 的环境不适用。

## 2. 安装系统依赖与 Caddy

在 root shell 执行：

```bash
apt-get update
apt-get install -y ca-certificates curl tar xz-utils python3 iproute2 passwd coreutils logrotate sqlite3 dnsutils gpg debian-keyring debian-archive-keyring apt-transport-https
```

`xz-utils` 用于解压 Node.js，`sqlite3` 用于一致性备份，`dnsutils` 用于 DNS 排错。系统需要有 `systemctl`、`useradd` 和 `runuser`。可先检查：

```bash
ps -p 1 -o comm=
command -v systemctl useradd runuser
ss -ltn '( sport = :80 or sport = :443 or sport = :4319 )'
```

PID 1 应为 systemd。新 VPS 上 80/443/4319 应没有已有应用监听；已有 Caddy 占用 80/443 属正常情况，继续复用它。若是其他程序，不要停止它来强行安装。

没有 Caddy 的新 VPS 使用 [Caddy 官方稳定软件源](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)：

```bash
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy-stable.gpg.key
gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy-stable.gpg.key
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
systemctl enable --now caddy
caddy version
systemctl is-active caddy
```

以上写入软件源和密钥的命令针对首次配置；已有文件时先审查，不盲目覆盖。使用当前官方稳定 Caddy，旧发行版包可能不支持站点中的 `request_body` 指令。保留包提供的 `/etc/caddy/Caddyfile`，此时不用手动添加桥接域名；安装器要求域名尚未出现在 `/etc/caddy` 中。

## 3. 下载、上传并校验服务器包

下载 v1.0.5 的 [`codex-device-hub.tar.gz`](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.5/codex-device-hub.tar.gz) 和同一发行版的 [`SHA256SUMS`](https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/v1.0.5/SHA256SUMS)。可在自己的电脑用浏览器下载后上传，也可直接在 VPS 下载，不需要 GitHub 令牌；下载不授予桥接服务账号。

先在 VPS root shell 创建上传目录：

```bash
install -d -m 0700 /root/codex-hub-release
```

使用浏览器下载时，回到自己电脑的下载目录，在 PowerShell 或终端上传；将 `VPS_IP` 替换为自己的地址：

```text
scp codex-device-hub.tar.gz SHA256SUMS root@VPS_IP:/root/codex-hub-release/
```

或者在 VPS root shell 直接下载同一发行版的公开资产：

```bash
cd /root/codex-hub-release
release_tag=v1.0.5
release_url="https://github.com/GengsengGhou/codex-mobile-bridge/releases/download/$release_tag"
curl -fL --proto '=https' --tlsv1.2 "$release_url/codex-device-hub.tar.gz" -o codex-device-hub.tar.gz
curl -fL --proto '=https' --tlsv1.2 "$release_url/SHA256SUMS" -o SHA256SUMS
```

无论使用哪种下载方式，都在 VPS root shell 校验：

```bash
cd /root/codex-hub-release
grep '  codex-device-hub.tar.gz$' SHA256SUMS | sha256sum --check -
```

必须得到 `codex-device-hub.tar.gz: OK`，否则停止。清单还有 Windows 文件，这里只校验服务器同名项；不要忽略校验失败。校验过的包可提取启动脚本：

```bash
tar -xzf codex-device-hub.tar.gz deploy/native-install.sh
```

下载失败时停止，核对 GitHub 可达性、发行版本及下载文件大小，不跳过校验。

## 4. 首次安装与 HTTPS

仍在 `/root/codex-hub-release`，把变量替换为自己已配置 DNS 的小写域名：

```bash
HUB_DOMAIN=codex.example.com
dig +short A "$HUB_DOMAIN"
dig +short AAAA "$HUB_DOMAIN"
bash deploy/native-install.sh install "$PWD/codex-device-hub.tar.gz" "$HUB_DOMAIN"
```

安装器先检查全部前置工具和已有安装情况，自动从 nodejs.org 下载当前 Node.js 22 官方包并校验其 HTTPS SHA-256 清单。运行时独立放在 `/opt/codex-mobile-hub/runtime`，不替换系统 Node；依赖按 lockfile 安装，关闭开发依赖和包脚本，因此还需 npm 网络访问。也可先运行 `bash deploy/native-install.sh runtime` 仅准备运行时，但该模式同样要求预装所有前置工具。

安装器验证完整归档成员路径，拒绝链接、路径穿越、私有点文件和非预期依赖；Hub 作为专用 `codexhub` 用户运行，只监听 `127.0.0.1:4319`。它写入：

| 路径 | 用途 |
| --- | --- |
| `/opt/codex-mobile-hub/app` | 应用程序 |
| `/opt/codex-mobile-hub/runtime` | 独立 Node.js 运行时 |
| `/etc/codex-mobile-hub.env` | 公共入口、监听及数据库配置，不含账号密码 |
| `/var/lib/codex-mobile-hub/hub.sqlite` | 账号、哈希凭据、设备归属与必要元数据 |
| `/etc/caddy/sites/codex-mobile-hub.caddy` | 本项目 HTTPS 站点 |
| `/var/log/codex-mobile-hub/service.log` | 私有服务日志 |

安装器备份原 Caddyfile，验证添加站点后的配置，再平滑 reload Caddy；不会替换其他网站。Caddy 自动签发并续期证书，DNS 正确且公网 80/443 可达后 HTTPS 才会可用；安装完成不代表证书已经签发成功。

```bash
systemctl is-active codex-mobile-hub caddy
ss -ltn 'sport = :4319'
curl -fsS -H "Host: $HUB_DOMAIN" http://127.0.0.1:4319/healthz
curl -fsS "https://$HUB_DOMAIN/healthz"
```

两个健康接口都应返回 `{"ok":true}`，监听地址应是 `127.0.0.1:4319`。不要把 Hub HTTP 端口直接暴露公网，也不要绕过 HTTPS 使用登录或设备配对。

## 5. 初始化管理员、邀请与配对

在交互式 SSH 终端执行，`admin` 可换成自己的账户名：

```bash
cd /opt/codex-mobile-hub/app
runuser -u codexhub -- env HUB_DB_PATH=/var/lib/codex-mobile-hub/hub.sqlite \
  /opt/codex-mobile-hub/runtime/bin/node hub/admin.mjs create-admin admin
```

提示出现后输入自己的密码，输入不会显示；建议至少 12 个 ASCII 字符。密码不要放进命令参数、环境变量、脚本、文件或日志。此初始化只允许数据库尚无账号时创建首个管理员；再次运行会拒绝，不是重置密码工具。当前没有网页重置密码流程，务必妥善保存管理员密码。

打开自己的 `https://域名`，使用管理员登录。页面的“邀请账户”中点击“生成邀请”，复制 24 小时一次性邀请，私下发给需要注册的人。每个邀请仅注册一个普通账号；不开放无邀请注册。管理员入口和真实网址无需提交 GitHub，受邀用户通过私下提供的网址连接。

自己也可以直接用管理员账号配对电脑。网页在“添加设备”填写设备名称并生成 10 分钟一次性配对码，再使用 Windows 安装器绑定。邀请用于注册、配对码用于绑定电脑，不能互换。Windows 下载、配对与手机登录按 [简易教程](quick-start.md#配对-windows-电脑) 操作。

## 健康检查与排错

新 SSH 会话中先重新设置自己的 `HUB_DOMAIN`。只读检查：

```bash
HUB_DOMAIN=codex.example.com
systemctl is-active codex-mobile-hub caddy codex-mobile-hub-maintenance.timer
systemctl is-enabled codex-mobile-hub caddy codex-mobile-hub-maintenance.timer
curl -fsS -H "Host: $HUB_DOMAIN" http://127.0.0.1:4319/healthz
curl -fsS "https://$HUB_DOMAIN/healthz"
tail -n 50 /var/log/codex-mobile-hub/service.log
journalctl -u caddy -n 50 --no-pager
```

| 现象 | 处理方向 |
| --- | --- |
| `Missing prerequisite` 或 Caddy inactive | 回到依赖步骤，确认当前为 root，系统使用 systemd，Caddy 已启动 |
| `Existing ... requires review` | 已有安装或前次留下部分配置；保留数据库和 Caddy 备份，检查具体失败位置后制定修复 / 升级方案，不反复运行安装器 |
| `Port 4319 is occupied` | 用 `ss` 检查现有应用，脚本不会停止它；不要杀掉不明进程 |
| 本地健康正常，HTTPS 失败 | 核对 A/AAAA、云防火墙和本机防火墙的 TCP 80/443、Caddy 证书日志；证书签发可能需要等待 |
| 本地健康报入口不匹配 | `Host` 必须匹配安装时的域名；用 IP 或 localhost 直接请求会被拒绝 |
| HTTPS 正常，设备离线 | 检查电脑开机、联网、Windows 登录、连接器状态及配对入口一致；VPS 健康不等于电脑已连上 |
| Node / npm 下载失败 | 确认 HTTPS 出站、DNS 和软件源可用；不要跳过 SHA 校验 |

日志和配置可能包含自己的域名或机器信息，分享排错前先脱敏，不公开密码、令牌、邀请链接、数据库或截图里的配对码。

服务已设置开机启动和异常退出恢复。主机重启后先检查上面的 `is-active` 和健康接口；正常不需重新创建管理员或重新配对。计划维护时先核对没有待确认操作，再只重启本项目：

```bash
systemctl restart codex-mobile-hub
```

这不是重启其他网站的命令。重启期间网页短暂离线；未知提交先查会话或回执，不直接重发。

## 数据库备份与升级

账号、设备与凭据哈希属于私有数据。下面使用 SQLite 备份 API，可在 Hub 运行时获得一致性数据库副本，不直接复制正在使用的单个 WAL 数据库文件：

```bash
install -d -m 0700 /var/backups/codex-mobile-hub
backup_file="/var/backups/codex-mobile-hub/hub-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sqlite3 -readonly /var/lib/codex-mobile-hub/hub.sqlite ".timeout 5000" ".backup '$backup_file'"
chmod 0600 "$backup_file"
sqlite3 -readonly "$backup_file" 'PRAGMA integrity_check;'
cp -a /etc/codex-mobile-hub.env /var/backups/codex-mobile-hub/
cp -a /etc/caddy/sites/codex-mobile-hub.caddy /var/backups/codex-mobile-hub/
```

完整性检查应为 `ok`。把已校验的版本归档、私有数据库备份和对应配置保存在受控位置，另存一份到其他机器；此教程不提供自动定期数据库备份。恢复时先停止本项目 Hub，保存当前数据库及 sidecar，再还原经验证的快照并恢复 `codexhub` 所有者 / 私有权限；不要向运行中的服务覆盖数据库。配置必须仍与当前域名和应用版本匹配。

安装脚本只负责首次安装，发现旧 `app` 会拒绝。升级需要先备份数据库与配置，检查新版兼容性，再明确替换应用目录并保留回滚路径。不要用删除 `/var/lib/codex-mobile-hub` 或重新初始化管理员代替升级。

运行中的 Node 进程不会重新载入已导入的协议模块。升级路由、连接器或 relay 时，不能只替换磁盘文件或仅重启 Hub：还要在没有进行中转发、未知投递或待确认操作的边界，核对并刷新本项目的常驻 connector、桥接 child 和 Hub；保留原 watcher/supervisor、配对凭据、偏好、数据库及环境配置。启动时间早于新协议的 connector 可能仍按旧路由表拒绝新请求，造成断开后重连。验收必须连续读取 status、会话 context/control，并包含一次条件 304，确认同一连接保持、错误类别正确及投递账本不变；不能以健康接口或磁盘 SHA 相等代替这些运行验收。升级后不要自动重试任何聊天、审批或新建提交。

Hub 默认限制为 256 MiB 内存及一个 CPU 核，记录清理和日志轮转已随 native 安装配置。项目维护任务保留限定目录中的最近三个应用回滚备份，**不自动备份数据库**；数据库备份保存在上述独立 `/var/backups` 中不受其应用清理范围影响。详见 [资源与保留策略](hub-resource-limits.md)。

## 没有自己的域名

当前原生和 Compose 安装器接受域名并配置 `https://域名`，没有稳定的裸 IP 一键安装路径。自签名证书会被普通浏览器或连接器拒绝，不能作为可直接使用的替代；即使平台支持 IP 证书，也需要自行维护 TLS 和更新流程，当前脚本没有包含。

可选择一个能控制 DNS 的免费 / 动态 DNS 主机名，并确认 A/AAAA 指向 VPS、可签发受信任证书后沿用教程；其可用性取决于域名提供方。也可以请已有服务管理员邀请你，无需自己的 VPS 或域名。只想临时访问单台电脑时，源码版可使用[临时 HTTPS 手机入口](temporary-mobile-access.md)；Quick Tunnel 地址会变化，不能承诺长期固定访问，也不是 VPS 多账号方案。
