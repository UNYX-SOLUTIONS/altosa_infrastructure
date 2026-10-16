#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck source=/dev/null
source .env
set +a
./scripts/configure-traefik-pgadmin.sh "${PGADMIN_PUBLIC_PORT:-5050}"
# --ignore-pull-failures: altosa-api se construye local (build:) y no existe
# en un registro; postgres/pgadmin sí se actualizan desde Docker Hub.
docker compose pull --ignore-pull-failures
# --build reconstruye altosa-api con el código actual; postgres/pgadmin siguen
# usando sus imágenes. Los volúmenes (datos y uploads) NO se tocan.
docker compose up -d --build
./scripts/connect-n8n.sh
./scripts/healthcheck.sh
