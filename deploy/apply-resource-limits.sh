#!/usr/bin/env bash
set -euo pipefail
umask 077
prefix=/opt/codex-mobile-hub
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
for command in systemctl systemd-analyze logrotate install; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
for path in "$prefix" "$prefix/app" /var/lib/codex-mobile-hub /var/log/codex-mobile-hub; do
  [[ ! -L $path ]] || { echo 'Project path must not be a symlink.' >&2; exit 1; }
done
[[ -x $prefix/runtime/bin/node && -d $prefix/app/deploy ]] || { echo 'Deploy the reviewed release first.' >&2; exit 1; }
getent passwd codexhub >/dev/null
systemd-analyze verify "$prefix/app/deploy/codex-mobile-hub.service" "$prefix/app/deploy/codex-mobile-hub-maintenance.service" "$prefix/app/deploy/codex-mobile-hub-maintenance.timer"
install -d -m 0700 -o codexhub -g codexhub /var/log/codex-mobile-hub
log=/var/log/codex-mobile-hub/service.log
[[ ! -L $log && ( ! -e $log || -f $log ) ]] || { echo 'Log target must be a regular file.' >&2; exit 1; }
if [[ ! -e $log ]]; then install -m 0600 -o codexhub -g codexhub /dev/null "$log"; fi
chown codexhub:codexhub "$log"
chmod 0600 "$log"
for name in codex-mobile-hub.service codex-mobile-hub-maintenance.service codex-mobile-hub-maintenance.timer; do
  [[ ! -L /etc/systemd/system/$name ]] || { echo 'Unit target must not be a symlink.' >&2; exit 1; }
  install -m 0644 "$prefix/app/deploy/$name" "/etc/systemd/system/$name"
done
[[ ! -L /etc/logrotate.d/codex-mobile-hub ]] || { echo 'Log policy target must not be a symlink.' >&2; exit 1; }
install -m 0644 "$prefix/app/deploy/codex-mobile-hub.logrotate" /etc/logrotate.d/codex-mobile-hub
logrotate --debug /etc/logrotate.d/codex-mobile-hub >/dev/null 2>&1
systemctl daemon-reload
systemctl enable --now codex-mobile-hub-maintenance.timer
echo 'Resource policies installed. Restart codex-mobile-hub during the reviewed release activation to apply its service limits.'
