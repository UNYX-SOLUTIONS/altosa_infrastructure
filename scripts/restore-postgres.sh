#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$#" -ne 1 ]; then echo "Uso: $0 backups/archivo.dump"; exit 1; fi
cd "$(dirname "$0")/.."
DUMP="$1"
[ -f "$DUMP" ] || { echo "ERROR: no existe $DUMP"; exit 1; }
set -a; source .env; set +a
read -r -p "Esto restaurará sobre la BD '$POSTGRES_DB'. Escriba RESTAURAR para continuar: " CONFIRM
[ "$CONFIRM" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
docker exec -i altosa-postgres pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$DUMP"
docker exec altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"
echo "Restauración completada."
