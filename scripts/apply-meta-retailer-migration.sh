#!/usr/bin/env bash
# Aplica la migración de Retailer IDs de Meta (WhatsApp Commerce) a la BD de Altosa.
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

SQL_FILE="backend/prisma/sql/meta_retailer_id.sql"
[ -f "$SQL_FILE" ] || { echo "ERROR: No existe $SQL_FILE." >&2; exit 1; }

# Preflight: si ya existen mapeos duplicados, el índice único fallaría a mitad
# del DDL. Detectarlos antes deja un error claro y no deja el esquema a medias.
META_COLUMN_EXISTS="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'meta_retailer_id';")"
if [ "$META_COLUMN_EXISTS" = "1" ]; then
  DUPLICATES="$(docker exec -i altosa-postgres psql -tA \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT string_agg(value || ' (' || cnt || ')', ', ') FROM (SELECT MIN(meta_retailer_id) AS value, count(*) AS cnt FROM product_variants WHERE meta_retailer_id IS NOT NULL GROUP BY LOWER(TRIM(meta_retailer_id)) HAVING count(*) > 1) d;")"
  [ -z "$DUPLICATES" ] || {
    echo "ERROR: hay Retailer IDs duplicados en product_variants: $DUPLICATES. Resuélvelos antes de aplicar el índice único." >&2
    exit 1
  }
fi

docker exec -i altosa-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL_FILE" >/dev/null

# Verificación explícita: si el DDL no dejó la columna/índice esperados, el
# despliegue debe fallar antes de arrancar la API nueva.
COLUMN_EXISTS="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'meta_retailer_id';")"
[ "$COLUMN_EXISTS" = "1" ] || {
  echo "ERROR: no existe product_variants.meta_retailer_id tras la migración." >&2
  exit 1
}

INDEX_DEF="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'product_variants' AND indexname = 'product_variants_meta_retailer_id_key';")"
case "$INDEX_DEF" in
  "CREATE UNIQUE INDEX "*) ;;
  *)
    echo "ERROR: no existe el índice único product_variants_meta_retailer_id_key tras la migración." >&2
    exit 1
    ;;
esac

LOCK_COLUMN="$(docker exec -i altosa-postgres psql -tA \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'meta_mapping_locked';")"
case "$LOCK_COLUMN" in
  "meta_mapping_locked:boolean:NO:false"*) ;;
  *)
    echo "ERROR: product_variants.meta_mapping_locked no quedó como BOOLEAN NOT NULL DEFAULT FALSE (valor: ${LOCK_COLUMN:-ausente})." >&2
    exit 1
    ;;
esac

echo "[✓] Migración meta_retailer_id + meta_mapping_locked aplicada."
