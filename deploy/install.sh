#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
for command in docker ss; do
  command -v "$command" >/dev/null || { printf '%s\n' "Missing prerequisite: $command. Install Docker Engine + Compose and iproute2 first." >&2; exit 1; }
done
docker compose version >/dev/null
docker info >/dev/null
if [[ -n "$(ss -H -ltn '( sport = :80 or sport = :443 )')" ]]; then
  printf '%s\n' 'Ports 80/443 are occupied. Integrate with the existing reverse proxy; this installer will not replace it.' >&2
  exit 1
fi
domain="${1:-}"
if [[ -z "$domain" ]]; then read -r -p 'Hub domain: ' domain; fi
if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || "$domain" != *.* || "$domain" == *..* ]]; then
  printf '%s\n' 'Invalid domain.' >&2; exit 1
fi
IFS=. read -ra labels <<< "$domain"
for label in "${labels[@]}"; do
  [[ ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { printf '%s\n' 'Invalid domain label.' >&2; exit 1; }
done
if [[ -e .env ]]; then
  printf '%s\n' 'deploy/.env already exists. Review it and use docker compose up -d --build for an upgrade.' >&2; exit 1
fi
umask 077
printf 'HUB_DOMAIN=%s\n' "$domain" > .env
docker compose config --quiet
docker compose up -d --build
printf '%s\n' 'Hub started. Initialize the first administrator using the server-side hidden password prompt:'
printf '%s\n' 'cd deploy && docker compose exec hub node hub/admin.mjs create-admin YOUR_USERNAME'
printf 'Open https://%s after DNS and TLS are ready.\n' "$domain"
