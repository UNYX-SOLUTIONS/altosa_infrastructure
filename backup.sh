#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
mkdir -p backups
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="backups/${POSTGRES_DB}_${STAMP}.dump"
docker exec altosa-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$FILE"
chmod 600 "$FILE"
echo "Backup creado: $FILE"
