#!/usr/bin/env bash
# Aplica la migración del nombre completo de variante a la BD de Altosa.
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

SQL_FILE="backend/prisma/sql/variant_nombre.sql"
[ -f "$SQL_FILE" ] || { echo "ERROR: No existe $SQL_FILE." >&2; exit 1; }

docker exec -i altosa-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL_FILE" >/dev/null

COLUMN_EXISTS="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'nombre';")"
[ "$COLUMN_EXISTS" = "1" ] || {
  echo "ERROR: no existe product_variants.nombre tras la migración." >&2
  exit 1
}

echo "[✓] Migración product_variants.nombre aplicada."
