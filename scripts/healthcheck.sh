#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck source=/dev/null
source .env
set +a

API_KEY="$(grep -m1 '^ALTOSA_API_KEY=' .env | cut -d= -f2-)"

echo "=== ALTOSA Healthcheck V4 ==="
docker compose ps
echo

echo "--- PostgreSQL ---"
docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
echo

echo "--- altosa-api ---"
docker exec altosa-api wget -qO- http://127.0.0.1:4100/health >/dev/null \
  && echo "OK: /health"
docker exec altosa-api wget -qO- --header="x-api-key: ${API_KEY}" \
  "http://127.0.0.1:4100/api/v1/products?page=1&pageSize=1&withVariants=true" >/dev/null \
  && echo "OK: /api/v1/products (withVariants) con x-api-key"
echo

echo "--- meta_retailer_id + meta_mapping_locked ---"
META_COL="$(docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='product_variants' AND column_name='meta_retailer_id';")"
META_LOCK_COL="$(docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='product_variants' AND column_name='meta_mapping_locked';")"
META_IDX="$(docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='product_variants' AND indexname='product_variants_meta_retailer_id_idx';")"
if [ -n "$META_COL" ] && [ -n "$META_LOCK_COL" ] && [ -n "$META_IDX" ]; then
  echo "OK: product_variants.$META_COL + product_variants.$META_LOCK_COL + $META_IDX"
else
  echo "ERROR: falta product_variants.meta_retailer_id, meta_mapping_locked o su índice (ejecuta scripts/apply-meta-retailer-migration.sh)" >&2
  exit 1
fi
echo

echo "--- kommo_templates ---"
KOMMO_TABLE="$(docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('public.kommo_templates');")"
KOMMO_VARIANT_COL="$(docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='product_variants' AND column_name='kommo_template_id';")"
if [ -n "$KOMMO_TABLE" ] && [ -n "$KOMMO_VARIANT_COL" ]; then
  echo "OK: $KOMMO_TABLE + product_variants.$KOMMO_VARIANT_COL"
else
  echo "ERROR: falta kommo_templates o product_variants.kommo_template_id (ejecuta scripts/apply-kommo-migration.sh)" >&2
  exit 1
fi
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
echo "API pública esperada: https://${ALTOSA_PUBLIC_DOMAIN}/health"
echo "pgAdmin esperado vía Traefik: http://IP_DEL_VPS:${PGADMIN_PUBLIC_PORT}"
