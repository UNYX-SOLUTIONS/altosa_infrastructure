#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
echo "=== Contenedores ==="
docker compose ps
echo "=== PostgreSQL ==="
docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
echo "=== pgvector ==="
docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
