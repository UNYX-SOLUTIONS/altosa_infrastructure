#!/usr/bin/env bash
# Backfill del nombre completo de variante (product_variants.nombre).
#
# Uso (desde el repo, en el VPS de Altosa):
#   bash scripts/backfill-variant-names.sh                 # dry-run
#   bash scripts/backfill-variant-names.sh --apply         # escribe
#   bash scripts/backfill-variant-names.sh --force --apply # regenera todo
#
# Genera:
#   data/variant-names-backfill.csv
#   data/variant-names-backfill-summary.json
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -qx 'altosa-api'; then
  echo "ERROR: el contenedor altosa-api no está en ejecución." >&2
  exit 1
fi

mkdir -p data

set +e
docker exec altosa-api node dist/scripts/backfill-variant-names.js \
  --report /tmp/variant-names-backfill.csv \
  --summary /tmp/variant-names-backfill-summary.json \
  "$@"
STATUS=$?
set -e

docker cp altosa-api:/tmp/variant-names-backfill.csv data/variant-names-backfill.csv 2>/dev/null || true
docker cp altosa-api:/tmp/variant-names-backfill-summary.json data/variant-names-backfill-summary.json 2>/dev/null || true

echo "Reporte local: data/variant-names-backfill.csv"
echo "Resumen local: data/variant-names-backfill-summary.json"
exit "$STATUS"
