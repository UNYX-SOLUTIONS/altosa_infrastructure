#!/usr/bin/env bash
# Compara las plantillas .env de producción (raíz) y local (backend).
# No imprime valores de secretos; solo claves, presencia y valores no sensibles.
#
# Uso:
#   bash scripts/check-env-examples.sh
#   bash scripts/check-env-examples.sh .env backend/.env   # archivos reales
set -Eeuo pipefail
cd "$(dirname "$0")/.."

PROD="${1:-.env.example}"
LOCAL="${2:-backend/.env.example}"
FAIL=0

for file in "$PROD" "$LOCAL"; do
  [ -f "$file" ] || { echo "ERROR: no existe $file"; exit 1; }
done

has() {
  grep -q "^$2=" "$1"
}

get() {
  awk -F= -v key="$2" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

require_key() {
  if ! has "$1" "$2"; then
    echo "FALTA $2 en $1"
    FAIL=1
  fi
}

# Claves comunes a local y producción: mismos nombres en ambos archivos.
COMMON_KEYS=(
  KOMMO_API_URL
  KOMMO_API_KEY
  META_CATALOG_ID
  META_ACCESS_TOKEN
  META_API_VERSION
)

for key in "${COMMON_KEYS[@]}"; do
  require_key "$PROD" "$key"
  require_key "$LOCAL" "$key"
done

# Valores no sensibles que deben coincidir entre local y producción.
for key in KOMMO_API_URL META_CATALOG_ID META_API_VERSION; do
  prod_value="$(get "$PROD" "$key")"
  local_value="$(get "$LOCAL" "$key")"
  if [ "$prod_value" != "$local_value" ]; then
    echo "DIFERENTE $key: producción='$prod_value' local='$local_value'"
    FAIL=1
  fi
done

# Obligatorias de producción (las que Compose necesita para interpolar).
for key in \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  PGADMIN_EMAIL PGADMIN_PASSWORD PGADMIN_PUBLIC_PORT PGADMIN_PUBLIC_DOMAIN \
  ALTOSA_API_KEY ALTOSA_PUBLIC_URL_BASE ALTOSA_PUBLIC_DOMAIN; do
  require_key "$PROD" "$key"
done

# Obligatorias del backend local (las que lee env.ts / pnpm dev).
for key in NODE_ENV PORT DATABASE_URL API_KEY UPLOAD_DIR PUBLIC_URL_BASE; do
  require_key "$LOCAL" "$key"
done

# Secretos que install.sh genera si están vacíos. En las plantillas deben estar
# vacíos; en un .env real de producción deben estar llenos.
for key in POSTGRES_PASSWORD PGADMIN_PASSWORD ALTOSA_API_KEY; do
  if [ -z "$(get "$PROD" "$key")" ]; then
    echo "AVISO: $key vacío en $PROD; install.sh lo genera. No uses docker compose directo con la plantilla."
  fi
done

# Tokens opcionales: su ausencia es válida (Meta/Kommo no configurados), pero si
# los usas deben estar configurados en el .env real de cada entorno.
for key in KOMMO_API_KEY META_ACCESS_TOKEN; do
  for file in "$PROD" "$LOCAL"; do
    if [ -z "$(get "$file" "$key")" ]; then
      echo "AVISO: $key vacío en $file (opcional; en producción configúralo si usas la integración)."
    fi
  done
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "ERROR: las plantillas no están alineadas. Revisa los mensajes anteriores."
  exit 1
fi

echo
echo "OK: plantillas alineadas."
echo "Común: KOMMO_* y META_*."
echo "Traducidas por Compose: POSTGRES_* -> DATABASE_URL, ALTOSA_API_KEY -> API_KEY, ALTOSA_PUBLIC_URL_BASE -> PUBLIC_URL_BASE."
echo "Fijas por Compose: NODE_ENV=production, PORT=4100, UPLOAD_DIR=/data/uploads."
