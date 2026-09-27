# Hub resource and retention policy

The VPS stores only account/password hashes, hashed credentials, device metadata,
invitations and pairing records in its SQLite database. Chat bodies, uploads and
downloads pass through RAM in acknowledged 64 KiB frames; the hub does not write
them to files or the database. It does not log HTTP bodies, query strings,
credentials or individual requests. The desktop remains the content source.

## Default admission limits

| Setting | Default | Scope |
| --- | ---: | --- |
| `HUB_GLOBAL_REQUESTS` | 24 | Active relay requests across all connectors |
| `HUB_USER_REQUESTS` | 8 | Active relay requests across one account's devices |
| `HUB_DEVICE_REQUESTS` | 8 | Active relay requests per connector |
| `HUB_CONNECTIONS` | 64 | Connected devices across accounts |
| `HUB_USER_CONNECTIONS` | 10 | Connected devices per account |
| `HUB_HTTP_CONNECTIONS` | 128 | All HTTP sockets, including upgraded sockets |
| `HUB_HTTP_REQUESTS` | 64 | Active ordinary HTTP requests |
| `HUB_MAX_USERS` | 256 | New-account admission; existing users survive |
| `HUB_DEVICE_RECORDS` | 4096 | All active plus retained revoked device rows |
| `HUB_REVOKED_DEVICE_RETENTION_DAYS` | 7 | Days of revoked-device metadata retained |
| `HUB_RELAY_BYTES_PER_SECOND` | 4194304 | Aggregate upload plus download payload bytes/sec |

Set these public, nonsecret values in the service environment or Compose
environment to adjust them. Invalid or out-of-range values stop startup. These
are limits for a small private hub, not a claim of production capacity. Login
hashing also has an existing global limit of four active operations and IP
attempt limits. Request admission returns 503 while saturated; it never queues
whole requests or replays writes. Replacing a connector settles its old requests
and preserves the shared account/global accounting.

The bandwidth scheduler grants FIFO frame turns across uploads and downloads,
with one initial frame burst. The next frame waits for its turn and the previous
frame's ACK or HTTP drain. Queued frames disappear on disconnect, expiry,
revocation or cancellation. Auth/ownership is checked again before a delayed
frame is forwarded. The default 24 active transfers can hold at most 24 pending
download frames (1.5 MiB) and 24 upload frames in the scheduler's callers; normal
HTTP/WebSocket/Node buffers are additional memory. The scheduler itself stores
byte counts and callbacks, not body buffers. Uploads remain capped at 20 MiB,
downloads at 100 MiB, and requests time out after two minutes. A very large
transfer can time out when many clients share the bandwidth cap.

## Retention

At startup and every 24 hours, the hub deletes expired sessions and expired or
used invitations/pairings, then checkpoints/truncates the SQLite WAL. Freed
database pages are reused. No per-request VACUUM runs. Accounts and current
sessions/devices are preserved. Revoked devices are removed seven days after
revocation (configurable); older rows without a revocation date receive seven
days from migration. Deleting a revoked hash cannot reactivate its credential.
The 4096-device-record global admission cap counts retained revoked records too,
so repeated pairing/revocation cannot grow that table without bound. A rejected
pairing keeps its code unused. An existing database above this cap keeps its
users and active devices; only new device admission stops until cleanup creates
space. The database retains its historical high-water size, with freed pages
reused.

Native deployment writes service stdout/stderr only to
`/var/log/codex-mobile-hub/service.log`. Its own logrotate policy rotates at a
1 MiB threshold and retains five compressed rotations. The project timer checks
hourly and on boot, so a log can exceed the threshold between checks. There is
no body/request logging; system-wide journald settings and other services are
unchanged. Compose uses bounded Docker JSON logs (1 MiB, five files) for the hub
and its dedicated Caddy container.

The native maintenance timer keeps the three newest rollback backups plus the
current active app, per exact
project scope: `backups/release-YYYYMMDD-HHmmss` (or UTC `YYYYMMDDTHHmmssZ`)
under `/opt/codex-mobile-hub`, legacy `app-backup-YYYYMMDDTHHmmssZ` directories
there, and `Caddyfile.codexhub-backup-YYYYMMDDTHHmmssZ` regular files under
`/etc/caddy`. It rejects symlink roots and ignores unrelated entries and symlink
backups. It never scans `/root`, SSH keys, active `app`, `runtime`, data, or other
services. Existing manual release snapshots under `/root` need explicit review
and remain intact. Keep persistent database backups outside these app-only
rollback scopes.

## Native release activation

The hub systemd unit has `MemoryHigh=192M`, `MemoryMax=256M`, one CPU quota,
64 tasks, 512 file descriptors and a 128 MiB Node old-generation heap limit.
Compose applies the same 256 MiB / one CPU / 64 PID ceiling. A hard memory limit
can terminate an overloaded process; dispatched mutations still report unknown
delivery and must not be automatically retried.

After deploying the reviewed complete app and preserving its env/database, run:

```bash
bash /opt/codex-mobile-hub/app/deploy/apply-resource-limits.sh
systemctl restart codex-mobile-hub
systemctl start codex-mobile-hub-maintenance.service
systemctl show codex-mobile-hub -p MemoryHigh -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax
systemctl is-active codex-mobile-hub codex-mobile-hub-maintenance.timer
```

The apply script validates and installs only project units and its logrotate
policy, enables the timer, and leaves release activation to the operator. It
does not modify the origin/environment file, database, Caddy site, system Node,
or another service. Verify local/public health with the existing hostname.

## Cache scope and validation

Static non-HTML assets use SHA-256 ETags with `private, no-cache`; each reuse
revalidates current content. Device asset responses still require the current
session and ownership before returning 304. HTML and hub authentication/context
JSON use `no-store`. Relay validators/ETags and bodyless 304 pass through without
a VPS JSON cache or any shared-account response cache.

Run `node --test test/hub-resources.test.mjs test/hub-relay.test.mjs
test/hub-server.test.mjs test/hub-connector.test.mjs` for fake-clock cleanup,
current-data preservation, admission, fair pacing, cancellation, backup safety,
conditional response auth boundaries and existing no-replay guarantees.
On 2026-09-27 the focused hub checks passed locally on Windows. The load check completed
24 concurrent downloads (3 MiB total) in 1001 ms, with 24 pending frames at peak
and 17.1 MiB process RSS growth including clients and their response buffers.
This is a measured fixture, not a VPS load or capacity certification.
