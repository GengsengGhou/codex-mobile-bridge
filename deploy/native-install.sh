#!/usr/bin/env bash
set -euo pipefail
umask 077
prefix=/opt/codex-mobile-hub
data=/var/lib/codex-mobile-hub
mode=${1:-}
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ $mode == runtime || $mode == install ]] || { echo 'Usage: native-install.sh runtime | install PACKAGE DOMAIN' >&2; exit 1; }
for command in curl tar sha256sum python3 ss useradd runuser systemctl caddy logrotate; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
[[ ! -L $prefix && ! -L $data ]] || { echo 'Installation paths must not be symlinks.' >&2; exit 1; }
install -d -m 0755 "$prefix"
work=$(mktemp -d "$prefix/.install.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
if [[ ! -x $prefix/runtime/bin/node ]]; then
  [[ ! -e $prefix/runtime ]] || { echo 'Existing incomplete runtime needs manual review.' >&2; exit 1; }
  case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
  curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 10 --max-time 180 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
  entry=$(awk -v suffix="linux-$arch.tar.xz" '$2 ~ (suffix "$" ) { print; exit }' "$work/SHASUMS256.txt")
  read -r digest archive <<< "$entry"
  [[ $digest =~ ^[a-f0-9]{64}$ && $archive =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Invalid official Node release metadata.' >&2; exit 1; }
  curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$work/$archive"
  printf '%s  %s\n' "$digest" "$work/$archive" | sha256sum --check --status
  install -d -m 0755 "$prefix/runtime"
  tar -xJf "$work/$archive" --strip-components=1 --no-same-owner -C "$prefix/runtime"
  chmod -R go+rX "$prefix/runtime"
fi
"$prefix/runtime/bin/node" --version
[[ $mode == install ]] || exit 0
package=${2:-}; domain=${3:-}
[[ -f $package && ! -L $package ]] || { echo 'Supply a regular release archive.' >&2; exit 1; }
[[ $domain =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $domain == *.* && $domain != *..* ]] || { echo 'Invalid domain.' >&2; exit 1; }
IFS=. read -ra labels <<< "$domain"
for label in "${labels[@]}"; do [[ ${#label} -le 63 && $label =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo 'Invalid domain label.' >&2; exit 1; }; done
[[ ! -e $prefix/app && ! -L $prefix/app ]] || { echo 'Existing app requires a reviewed upgrade plan.' >&2; exit 1; }
[[ ! -e /etc/systemd/system/codex-mobile-hub.service && ! -e /etc/codex-mobile-hub.env && ! -e /etc/caddy/sites/codex-mobile-hub.caddy ]] || { echo 'Existing hub configuration requires review.' >&2; exit 1; }
[[ -z $(ss -H -ltn 'sport = :4319') ]] || { echo 'Port 4319 is occupied; no process was stopped.' >&2; exit 1; }
systemctl is-active --quiet caddy
if grep -RqF -- "$domain" /etc/caddy; then echo 'Domain already appears in Caddy configuration; review required.' >&2; exit 1; fi
python3 - "$package" <<'PY'
import sys, tarfile
allowed = {'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'hub', 'public', 'src', 'scripts', 'deploy', 'docs', 'node_modules'}
size = 0
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for item in archive:
        parts = item.name.rstrip('/').split('/')
        if not parts or parts[0] not in allowed or any(part in ('', '.', '..') for part in parts) or '\\' in item.name or not (item.isdir() or item.isfile()):
            raise SystemExit('Unsafe release member rejected')
        if any(part.startswith('.') for part in parts) and item.name != 'deploy/.env.example':
            raise SystemExit('Private release member rejected')
        if parts[0] == 'node_modules' and (len(parts) < 2 or parts[1] != 'ws'):
            raise SystemExit('Unexpected bundled dependency rejected')
        size += item.size
        if size > 100 * 1024 * 1024:
            raise SystemExit('Release is too large')
PY
install -d -m 0755 "$work/app"
tar -xzf "$package" --no-same-owner --no-same-permissions -C "$work/app"
chmod -R go+rX "$work/app"
export PATH="$prefix/runtime/bin:$PATH"
(cd "$work/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod -R go+rX "$work/app"
[[ -f $work/app/deploy/codex-mobile-hub.service ]] || { echo 'Release is missing the native service unit.' >&2; exit 1; }
if ! getent passwd codexhub >/dev/null; then useradd --system --user-group --home-dir "$data" --no-create-home --shell /usr/sbin/nologin codexhub; fi
[[ $(getent passwd codexhub | cut -d: -f6) == "$data" ]] || { echo 'Existing codexhub account conflicts with installation.' >&2; exit 1; }
install -d -m 0700 -o codexhub -g codexhub "$data"
mv -- "$work/app" "$prefix/app"
install -m 0644 "$prefix/app/deploy/codex-mobile-hub.service" /etc/systemd/system/codex-mobile-hub.service
install -d -m 0700 -o codexhub -g codexhub /var/log/codex-mobile-hub
log=/var/log/codex-mobile-hub/service.log
[[ ! -L $log && ( ! -e $log || -f $log ) ]] || { echo 'Log target must be a regular file.' >&2; exit 1; }
if [[ ! -e $log ]]; then install -m 0600 -o codexhub -g codexhub /dev/null "$log"; fi
chown codexhub:codexhub "$log"
chmod 0600 "$log"
install -m 0644 "$prefix/app/deploy/codex-mobile-hub.logrotate" /etc/logrotate.d/codex-mobile-hub
install -m 0644 "$prefix/app/deploy/codex-mobile-hub-maintenance.service" /etc/systemd/system/codex-mobile-hub-maintenance.service
install -m 0644 "$prefix/app/deploy/codex-mobile-hub-maintenance.timer" /etc/systemd/system/codex-mobile-hub-maintenance.timer
printf 'HUB_PUBLIC_ORIGIN=https://%s\nHUB_TRUST_PRIVATE_PROXY=1\nHUB_BIND_HOST=127.0.0.1\nPORT=4319\nHUB_DB_PATH=%s/hub.sqlite\nNODE_ENV=production\n' "$domain" "$data" > /etc/codex-mobile-hub.env
systemctl daemon-reload
systemctl enable --now codex-mobile-hub.service
systemctl enable --now codex-mobile-hub-maintenance.timer
healthy=0
for attempt in {1..20}; do
  if curl -fsS --max-time 2 -H "Host: $domain" http://127.0.0.1:4319/healthz > "$work/health.json"; then healthy=1; break; fi
  sleep 1
done
[[ $healthy == 1 ]] || { echo 'Hub health failed; Caddy was not changed.' >&2; exit 1; }
install -d -m 0755 /etc/caddy/sites
site=/etc/caddy/sites/codex-mobile-hub.caddy
cat > "$site" <<CADDY
$domain {
    encode zstd gzip
    request_body {
        max_size 21MB
    }
    reverse_proxy 127.0.0.1:4319 {
        header_up X-Hub-Client-IP {remote_host}
    }
}
CADDY
chmod 0644 "$site"
backup="/etc/caddy/Caddyfile.codexhub-backup-$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=all /etc/caddy/Caddyfile "$backup"
chmod 0600 "$backup"
candidate=/etc/caddy/Caddyfile.codexhub-candidate
cp --preserve=all /etc/caddy/Caddyfile "$candidate"
printf '\nimport /etc/caddy/sites/codex-mobile-hub.caddy\n' >> "$candidate"
if ! caddy validate --config "$candidate" --adapter caddyfile > "$work/caddy-validation.log" 2>&1; then
  rm -f -- "$candidate" "$site"; echo 'Caddy validation failed; existing configuration was preserved.' >&2; exit 1
fi
cp --preserve=all "$candidate" /etc/caddy/Caddyfile
rm -f -- "$candidate"
if ! systemctl reload caddy; then
  cp --preserve=all "$backup" /etc/caddy/Caddyfile; chmod 0644 /etc/caddy/Caddyfile
  systemctl reload caddy; echo 'Caddy reload failed; original configuration restored.' >&2; exit 1
fi
printf 'Hub active; Caddy validated and gracefully reloaded.\nSite: %s\nBackup: %s\n' "$site" "$backup"
echo 'Initialize the first administrator separately through stdin; keep the password out of files, environment and command arguments.'
