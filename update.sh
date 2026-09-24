#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
./scripts/configure-traefik-pgadmin.sh "${PGADMIN_PUBLIC_PORT:-5050}"
docker compose pull
docker compose up -d
./scripts/connect-n8n.sh
./scripts/healthcheck.sh
