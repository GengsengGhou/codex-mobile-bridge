# Native Ubuntu VPS Deployment

This variant shares an existing Caddy installation. It adds one site and runs the
hub as `codexhub` on `127.0.0.1:4319`. It preserves other sites and services.

The installer requires root, Ubuntu's standard `curl`, `tar`, `python3`,
`iproute2`, `systemd`, `logrotate`, and an already active Caddy service. It downloads the latest
Node 22 release from nodejs.org into `/opt/codex-mobile-hub/runtime` and verifies
its official HTTPS SHA-256 manifest. It does not change the system Node binary.

After the full test suite passes, create the release archive using
`node deploy/package.mjs`, transfer it and its checksum to the VPS, and verify
the checksum before running:

```bash
bash deploy/native-install.sh runtime
bash deploy/native-install.sh install /root/codex-device-hub.tar.gz codex.example.com
```

The archive must contain the native service unit. Archive paths are checked
before extraction; links, traversal paths and private dotfiles are rejected.
Dependencies are installed from the lockfile with development packages and
package scripts disabled. Initial installations refuse existing hub artifacts,
occupied port 4319, or an existing Caddy reference to the requested hostname.

The service reads `/etc/codex-mobile-hub.env`, containing only public origin,
loopback binding and database location. The SQLite database is private to
`codexhub` under `/var/lib/codex-mobile-hub` (mode 0700). The unit's 0077 umask
keeps new database files private. Its filesystem is read-only except that data
directory, its project log directory and its isolated temporary directory.
The unit caps memory at 256 MiB and CPU at one core. See
[hub resource and retention policy](hub-resource-limits.md) for request,
bandwidth, account and connection limits, daily metadata cleanup, project log
rotation, backup retention and the existing-installation apply script.

Initialize the administrator through a hidden prompt or stdin:

```bash
cd /opt/codex-mobile-hub/app
runuser -u codexhub -- env HUB_DB_PATH=/var/lib/codex-mobile-hub/hub.sqlite \
  /opt/codex-mobile-hub/runtime/bin/node hub/admin.mjs create-admin admin
```

Do not put the password in command arguments, environment variables, service
configuration, scripts or logs. Change the initial password only through a
supported account-management procedure.

The installer creates `/etc/caddy/sites/codex-mobile-hub.caddy` and imports only
that file. It saves a root-private timestamped copy of the original Caddyfile,
validates the combined candidate, and gracefully reloads Caddy. The new site
limits HTTP bodies to 21 MB and overwrites `X-Hub-Client-IP` from the immediate
remote address. DNS must point the chosen domain at this VPS for public TLS.

Verify without displaying configuration contents or credentials:

```bash
systemctl is-active codex-mobile-hub caddy
ss -ltn 'sport = :4319'
curl -fsS -H 'Host: codex.example.com' http://127.0.0.1:4319/healthz
curl -fsS https://codex.example.com/healthz
```

Keep the existing Caddy backup and database. Before an upgrade, back up SQLite
using SQLite's backup API and prepare an explicit app-directory replacement
with rollback. This initial installer deliberately stops when it finds an
existing app. To roll back the site addition, restore the recorded Caddyfile
backup's original permissions, validate it, and reload Caddy; stop only
`codex-mobile-hub`, leaving every other service running.
