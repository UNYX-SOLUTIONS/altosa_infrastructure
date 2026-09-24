#!/usr/bin/env bash
set -Eeuo pipefail
[ $# -eq 1 ] || { echo "Uso: $0 backups/archivo.dump"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; source .env; set +a
[ -f "$1" ] || { echo "No existe: $1"; exit 1; }
cat "$1" | docker exec -i altosa-postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner
echo "Restauración terminada."
