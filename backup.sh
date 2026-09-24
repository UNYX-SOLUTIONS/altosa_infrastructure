#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
mkdir -p backups
FILE="backups/altosa_$(date +%Y%m%d_%H%M%S).dump"
docker exec altosa-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$FILE"
echo "Backup creado: $FILE"
