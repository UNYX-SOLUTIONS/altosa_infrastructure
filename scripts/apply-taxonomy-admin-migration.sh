#!/usr/bin/env bash
# Aplica la migración de administración de taxonomía a la BD de Altosa.
# Es idempotente: se puede ejecutar en cada install/update.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "ERROR: No existe .env." >&2; exit 1; }
set -a
# shellcheck source=/dev/null
source .env
set +a

: "${POSTGRES_USER:?Falta POSTGRES_USER en .env}"
: "${POSTGRES_DB:?Falta POSTGRES_DB en .env}"

SQL_FILE="backend/prisma/sql/taxonomy_admin.sql"
[ -f "$SQL_FILE" ] || { echo "ERROR: No existe $SQL_FILE." >&2; exit 1; }

docker exec -i altosa-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL_FILE" >/dev/null

COLUMNS="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='categories' AND column_name IN ('is_active','is_system','sort_order')) OR (table_name='subcategories' AND column_name IN ('is_active','is_system','sort_order')));")"
[ "$COLUMNS" = "6" ] || {
  echo "ERROR: no se crearon las 6 columnas de taxonomía esperadas." >&2
  exit 1
}

echo "[✓] Migración de taxonomía (is_active, is_system, sort_order) aplicada."
