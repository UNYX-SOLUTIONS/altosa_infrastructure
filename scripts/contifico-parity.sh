#!/usr/bin/env bash
# Auditoría de paridad Altosa vs Contifico (solo lectura).
#
# Uso (desde el repo, en el VPS de Altosa):
#   bash scripts/contifico-parity.sh
#   bash scripts/contifico-parity.sh --only-active
#   bash scripts/contifico-parity.sh --fail-on-mismatch
#
# Genera:
#   data/contifico-parity-report.csv   (detalle por variante)
#   /tmp/contifico-parity-summary.json (conteos y muestras, dentro del contenedor)
#
# Requiere que la imagen tenga el script compilado:
#   pnpm --dir backend build   (o el build de Docker/update.sh)
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -qx 'altosa-api'; then
  echo "ERROR: el contenedor altosa-api no está en ejecución." >&2
  exit 1
fi

mkdir -p data

set +e
docker exec altosa-api node dist/scripts/audit-contifico-parity.js \
  --report /tmp/contifico-parity.csv \
  --summary /tmp/contifico-parity-summary.json \
  "$@"
STATUS=$?
set -e

docker cp altosa-api:/tmp/contifico-parity.csv data/contifico-parity-report.csv 2>/dev/null || true
docker cp altosa-api:/tmp/contifico-parity-summary.json data/contifico-parity-summary.json 2>/dev/null || true

echo "Reporte local: data/contifico-parity-report.csv"
echo "Resumen local: data/contifico-parity-summary.json"
exit "$STATUS"
