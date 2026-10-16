#!/usr/bin/env bash
set -Eeuo pipefail
[ $# -eq 1 ] || { echo "Uso: $0 backups/archivo.dump"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck source=/dev/null
source .env
set +a
[ -f "$1" ] || { echo "No existe: $1"; exit 1; }
cat "$1" | docker exec -i altosa-postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner

# Avanza las secuencias de identidad al máximo actual de cada tabla.
# Sin esto, los INSERT nuevos (API/n8n) fallan con ids duplicados cuando el
# dump no incluye el estado de las secuencias.
docker exec -i altosa-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT format(
  'SELECT setval(%L, (SELECT COALESCE(max(%I), 1) FROM %I)) AS seq_fixed;',
  pg_get_serial_sequence(quote_ident(table_name), column_name),
  column_name,
  table_name)
FROM information_schema.columns
WHERE table_schema = 'public' AND is_identity = 'YES'
\gexec
SQL

echo "Restauración terminada (secuencias de identidad sincronizadas)."
