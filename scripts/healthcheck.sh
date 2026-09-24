#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a

echo "=== ALTOSA Healthcheck ==="
docker compose ps
echo
echo "--- PostgreSQL ---"
docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
echo
echo "--- altosa_backend ---"
docker network inspect altosa_backend --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
echo
echo "--- Puertos publicados ---"
docker ps --format 'table {{.Names}}\t{{.Ports}}'
