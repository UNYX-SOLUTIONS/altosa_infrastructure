#!/usr/bin/env bash
set -Eeuo pipefail
if [ $# -ne 1 ]; then
  echo "Uso: $0 backups/archivo.dump"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
source .env
set +a
FILE="$1"
[ -f "$FILE" ] || { echo "No existe: $FILE"; exit 1; }

cat "$FILE" | docker exec -i altosa-postgres pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner
echo "Restauración terminada."
