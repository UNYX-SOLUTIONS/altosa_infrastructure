#!/usr/bin/env bash
# Normaliza categorías/subcategorías de Altosa a la taxonomía canónica.
#
# Uso (desde el repo, en el VPS de Altosa):
#   bash scripts/normalize-taxonomy.sh              # dry-run: reporte, no escribe
#   bash scripts/normalize-taxonomy.sh --apply      # aplica cambios y purga vacías
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -qx 'altosa-api'; then
  echo "ERROR: el contenedor altosa-api no está en ejecución." >&2
  exit 1
fi

mkdir -p data

set +e
docker exec altosa-api node dist/scripts/normalize-taxonomy.js \
  --report /tmp/taxonomy-normalization.csv \
  --summary /tmp/taxonomy-normalization-summary.json \
  "$@"
STATUS=$?
set -e

docker cp altosa-api:/tmp/taxonomy-normalization.csv data/taxonomy-normalization.csv 2>/dev/null || true
docker cp altosa-api:/tmp/taxonomy-normalization-summary.json data/taxonomy-normalization-summary.json 2>/dev/null || true

echo "Reporte local: data/taxonomy-normalization.csv"
echo "Resumen local: data/taxonomy-normalization-summary.json"
exit "$STATUS"
