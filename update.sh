#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck source=/dev/null
source .env
set +a
./scripts/configure-traefik-pgadmin.sh "${PGADMIN_PUBLIC_PORT:-5050}"
docker compose pull
# --build reconstruye altosa-api con el código actual; postgres/pgadmin siguen
# usando sus imágenes. Los volúmenes (datos y uploads) NO se tocan.
docker compose up -d --build
./scripts/connect-n8n.sh
./scripts/healthcheck.sh
