#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"
COMPOSE_FILE="$REPO_DIR/docker-compose.yml"
BACKUP_FILE="${1:-$REPO_DIR/backend/sql/altosa_2026-10-15.schema.backup}"
PG_CONTAINER="${PG_CONTAINER:-altosa-postgres}"
API_SERVICE="${API_SERVICE:-api}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: no existe $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: no existe el backup $BACKUP_FILE" >&2
  echo "Uso: $0 [ruta/al/backup]" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${POSTGRES_USER:?Falta POSTGRES_USER en .env}"
: "${POSTGRES_DB:?Falta POSTGRES_DB en .env}"

echo "============================================================"
echo " RESET DE LA BASE DE ALTOSA"
echo "============================================================"
echo " Base:      $POSTGRES_DB"
echo " Contenedor: $PG_CONTAINER"
echo " Backup:    $BACKUP_FILE"
echo
echo " ESTO BORRA TODA LA BASE ACTUAL Y RESTAURA EL BACKUP."
echo " No crea otra base: reutiliza $POSTGRES_DB."
echo "============================================================"
read -r -p "Escribe RESET para continuar: " confirmation
if [ "$confirmation" != "RESET" ]; then
  echo "Cancelado."
  exit 1
fi

mkdir -p "$REPO_DIR/backups"
CURRENT_BACKUP="$REPO_DIR/backups/altosa_antes_reset_$(date +%Y%m%d_%H%M%S).dump"

echo "[1/8] Guardando dump de la base actual..."
docker exec "$PG_CONTAINER" pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$CURRENT_BACKUP" || true
echo "      Dump actual: $CURRENT_BACKUP"

echo "[2/8] Deteniendo API..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop "$API_SERVICE" || true

echo "[3/8] Terminando conexiones y recreando $POSTGRES_DB..."
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$POSTGRES_DB' AND pid <> pg_backend_pid();"
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$POSTGRES_DB\";"
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$POSTGRES_DB\";"

echo "[4/8] Habilitando extensión vector..."
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "[5/8] Restaurando backup..."
docker cp "$BACKUP_FILE" "$PG_CONTAINER:/tmp/altosa_reset.backup"
docker exec -i "$PG_CONTAINER" pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --no-privileges /tmp/altosa_reset.backup \
  2>&1 | tee /tmp/altosa_reset_restore.log || true

echo "[6/8] Aplicando migraciones Meta/Kommo..."
for sql in \
  "$REPO_DIR/backend/prisma/sql/meta_retailer_id.sql" \
  "$REPO_DIR/backend/prisma/sql/kommo_templates.sql"
do
  if [ -f "$sql" ]; then
    echo "      Aplicando $(basename "$sql")..."
    docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -v ON_ERROR_STOP=1 < "$sql"
  fi
done

echo "[7/8] Creando índice único de meta_retailer_id..."
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "CREATE UNIQUE INDEX IF NOT EXISTS product_variants_meta_retailer_id_key
        ON product_variants (lower(btrim(meta_retailer_id)))
        WHERE meta_retailer_id IS NOT NULL;"

echo "[8/8] Verificando conteos del backup..."
RESULT="$(docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F'|' -c "
  SELECT
    (SELECT count(*) FROM products),
    (SELECT count(*) FROM products WHERE is_active),
    (SELECT count(*) FROM product_variants),
    (SELECT count(*) FROM product_variants WHERE is_active);
")"
echo "      productos|activos|variantes|variantes_activas = $RESULT"

PRODUCTS="$(echo "$RESULT" | cut -d'|' -f1)"
ACTIVE_PRODUCTS="$(echo "$RESULT" | cut -d'|' -f2)"
VARIANTS="$(echo "$RESULT" | cut -d'|' -f3)"
ACTIVE_VARIANTS="$(echo "$RESULT" | cut -d'|' -f4)"

if [ "$PRODUCTS" != "110" ] || [ "$ACTIVE_PRODUCTS" != "110" ] || [ "$VARIANTS" != "241" ] || [ "$ACTIVE_VARIANTS" != "241" ]; then
  echo "ERROR: los conteos no coinciden con el backup esperado (110/110, 241/241)." >&2
  echo "Revisa /tmp/altosa_reset_restore.log en el host." >&2
  echo "La API quedó detenida. Dump anterior: $CURRENT_BACKUP" >&2
  exit 1
fi

echo "[✓] Base restaurada desde el backup con 110 productos / 241 variantes activas."
echo
echo "Siguiente paso:"
echo "  1. Desplegar el código de Altosa con la preservación de contenido aprobado."
echo "  2. Generar el export de Contifico y sembrarlo con seed:products."
echo "  3. Mapear/importar Meta."
echo
echo "La API sigue detenida. Levántala cuando termines de verificar:"
echo "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE start $API_SERVICE"
