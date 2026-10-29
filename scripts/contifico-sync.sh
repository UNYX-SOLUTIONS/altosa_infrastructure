#!/usr/bin/env bash
# Ejecuta el sync Contifico -> Altosa dentro del contenedor altosa-api.
# No usa tokens en el host: el contenedor ya tiene CONTIFICO_API_KEY y API_KEY.
#
# Uso:
#   bash scripts/contifico-sync.sh --dry-run
#   bash scripts/contifico-sync.sh --apply
#   bash scripts/contifico-sync.sh --apply --create-missing --prune
#
# --apply es el modo por defecto; --dry-run no escribe en la DB.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

DRY="false"
MATCH="true"
CREATE="false"
PRUNE="false"
ONLY_SKU=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY="true" ;;
    --apply) DRY="false" ;;
    --match-by-name) MATCH="true" ;;
    --no-match-by-name) MATCH="false" ;;
    --create-missing) CREATE="true" ;;
    --prune) PRUNE="true" ;;
    --only-sku=*) ONLY_SKU="${arg#*=}" ;;
    *)
      echo "Opción no reconocida: $arg" >&2
      echo "Uso: $0 [--dry-run|--apply] [--match-by-name|--no-match-by-name] [--create-missing] [--prune] [--only-sku=SKU]" >&2
      exit 1
      ;;
  esac
done

if [ -n "$ONLY_SKU" ]; then
  BODY=$(printf '{"dryRun":%s,"matchByName":%s,"createMissing":%s,"prune":%s,"onlySku":"%s"}' \
    "$DRY" "$MATCH" "$CREATE" "$PRUNE" "$ONLY_SKU")
else
  BODY=$(printf '{"dryRun":%s,"matchByName":%s,"createMissing":%s,"prune":%s}' \
    "$DRY" "$MATCH" "$CREATE" "$PRUNE")
fi

echo "[*] POST /api/v1/contifico/sync dryRun=$DRY matchByName=$MATCH createMissing=$CREATE prune=$PRUNE"
docker exec -e SYNC_BODY="$BODY" altosa-api node -e '
const body = process.env.SYNC_BODY;
fetch("http://127.0.0.1:4100/api/v1/contifico/sync", {
  method: "POST",
  headers: {
    "x-api-key": process.env.API_KEY,
    "Content-Type": "application/json",
  },
  body,
})
  .then(async (response) => {
    const text = await response.text();
    console.log(text);
    process.exit(response.ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
'
