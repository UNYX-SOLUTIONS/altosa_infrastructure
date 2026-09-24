#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 1 ]] || { echo "Uso: $0 archivo.dump"; exit 1; }
FILE="$1"
[[ -f "$FILE" ]] || { echo "No existe: $FILE"; exit 1; }
cd "$(dirname "$0")/.."
set -a; source .env; set +a
cat "$FILE" | docker exec -i altosa-postgres pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"
echo "Restauracion completada"
