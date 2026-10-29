#!/usr/bin/env bash
# Aplica la migración de referencias planas de Contifico a la BD de Altosa.
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

SQL_FILE="backend/prisma/sql/contifico_mapping.sql"
[ -f "$SQL_FILE" ] || { echo "ERROR: No existe $SQL_FILE." >&2; exit 1; }

# Preflight: si ya existen mapeos duplicados, el índice único fallaría a mitad
# del DDL. Detectarlos antes deja un error claro y no deja el esquema a medias.
CONTIFICO_COLUMN_EXISTS="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'contifico_id';")"
if [ "$CONTIFICO_COLUMN_EXISTS" = "1" ]; then
  DUPLICATES="$(docker exec -i altosa-postgres psql -tA \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT string_agg(value || ' (' || cnt || ')', ', ') FROM (SELECT MIN(contifico_id) AS value, count(*) AS cnt FROM product_variants WHERE contifico_id IS NOT NULL GROUP BY LOWER(TRIM(contifico_id)) HAVING count(*) > 1) d;")"
  [ -z "$DUPLICATES" ] || {
    echo "ERROR: hay IDs de Contifico duplicados en product_variants: $DUPLICATES. Resuélvelos antes de aplicar el índice único." >&2
    exit 1
  }
fi

docker exec -i altosa-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL_FILE" >/dev/null

ID_COLUMN="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'contifico_id';")"
[ "$ID_COLUMN" = "1" ] || {
  echo "ERROR: no existe product_variants.contifico_id tras la migración." >&2
  exit 1
}

SKU_COLUMN="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'contifico_sku';")"
[ "$SKU_COLUMN" = "1" ] || {
  echo "ERROR: no existe product_variants.contifico_sku tras la migración." >&2
  exit 1
}

INDEX_DEF="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'product_variants' AND indexname = 'product_variants_contifico_id_key';")"
case "$INDEX_DEF" in
  "CREATE UNIQUE INDEX "*) ;;
  *)
    echo "ERROR: no existe el índice único product_variants_contifico_id_key tras la migración." >&2
    exit 1
    ;;
esac

echo "[✓] Migración contifico_id + contifico_sku aplicada."
