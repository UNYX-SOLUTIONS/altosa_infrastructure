#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck source=/dev/null
source .env
set +a
mkdir -p backups

TS="$(date +%Y%m%d_%H%M%S)"

# 1) Base de datos
FILE="backups/altosa_${TS}.dump"
docker exec altosa-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$FILE"
echo "Backup BD creado: $FILE"

# 2) Imágenes subidas (volumen altosa_uploads_data, usado por altosa-api)
if docker volume inspect altosa_uploads_data >/dev/null 2>&1; then
  UPLOADS_FILE="backups/altosa_uploads_${TS}.tar.gz"
  docker run --rm \
    -v altosa_uploads_data:/data:ro \
    -v "$(pwd)/backups":/backup \
    alpine tar -czf "/backup/$(basename "$UPLOADS_FILE")" -C /data .
  echo "Backup imágenes creado: $UPLOADS_FILE"
else
  echo "Aviso: el volumen altosa_uploads_data no existe todavía (sin imágenes subidas)."
fi
