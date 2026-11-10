#!/usr/bin/env bash
# Aplica la migración de precisión de precio (4 decimales) e IVA por variante.
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

SQL_FILE="backend/prisma/sql/variant_price_iva.sql"
[ -f "$SQL_FILE" ] || { echo "ERROR: No existe $SQL_FILE." >&2; exit 1; }

docker exec -i altosa-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL_FILE" >/dev/null

PRICE_PRECISION="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT numeric_precision || ',' || numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'precio_usd';")"
[ "$PRICE_PRECISION" = "14,4" ] || {
  echo "ERROR: product_variants.precio_usd no quedó en NUMERIC(14,4) (actual: $PRICE_PRECISION)." >&2
  exit 1
}

IVA_COLUMN="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'porcentaje_iva';")"
[ "$IVA_COLUMN" = "1" ] || {
  echo "ERROR: no existe product_variants.porcentaje_iva tras la migración." >&2
  exit 1
}

echo "[✓] Migración product_variants.precio_usd(14,4) + porcentaje_iva aplicada."
