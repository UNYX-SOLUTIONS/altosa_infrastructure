#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

echo "=== ALTOSA Healthcheck V4 ==="
docker compose ps
echo
docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
echo
echo "--- altosa_backend ---"
docker network inspect altosa_backend --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
echo
echo "--- n8n -> PostgreSQL TCP ---"
N8N="$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /docker\.n8n\.io\/n8nio\/n8n|(^|\/)n8n(\/n8n)?:/ {print $1; exit}')"
if [ -n "$N8N" ]; then
  docker exec "$N8N" node -e "const net=require('net');const s=net.createConnection(5432,'altosa-postgres');s.on('connect',()=>{console.log('OK: n8n puede conectar con altosa-postgres:5432');s.end()});s.on('error',e=>{console.error('ERROR:',e.message);process.exit(1)})"
fi
echo
echo "--- Puertos ---"
docker ps --format 'table {{.Names}}\t{{.Ports}}'
echo
echo "pgAdmin esperado vía Traefik: http://IP_DEL_VPS:${PGADMIN_PUBLIC_PORT}"
