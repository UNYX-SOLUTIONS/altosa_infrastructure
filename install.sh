#!/usr/bin/env bash
# ============================================================================
# ALTOSA Infrastructure - Instalación / primer despliegue
#
# Uso:
#   sudo bash install.sh
#   sudo bash install.sh api.altosamobiliario.com
#
# Variables opcionales:
#   ALTOSA_PUBLIC_DOMAIN=api.altosamobiliario.com
#   ALTOSA_PUBLIC_URL_BASE=https://api.altosamobiliario.com
#   PGADMIN_PUBLIC_DOMAIN=dbglobal.altosamobiliario.com
#
# El script conserva un .env existente y solo agrega/completa las claves que
# falten (API key, URL/dominio público, credenciales de pgAdmin).
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"

PUBLIC_DOMAIN="${ALTOSA_PUBLIC_DOMAIN:-${1:-api.altosamobiliario.com}}"
PUBLIC_URL_BASE="${ALTOSA_PUBLIC_URL_BASE:-https://${PUBLIC_DOMAIN}}"
PGADMIN_DOMAIN="${PGADMIN_PUBLIC_DOMAIN:-dbglobal.altosamobiliario.com}"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nAVISO: %s\n' "$*" >&2; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

echo "=== ALTOSA Infrastructure V4 ==="
echo "PostgreSQL + pgvector + pgAdmin + altosa-api (Traefik)"
echo

command -v docker >/dev/null 2>&1 || fail "Docker no está instalado."
docker compose version >/dev/null 2>&1 || fail "Docker Compose no está disponible."
command -v openssl >/dev/null 2>&1 || fail "openssl no está instalado."

log "Red interna altosa_backend"
if ! docker network inspect altosa_backend >/dev/null 2>&1; then
  docker network create altosa_backend >/dev/null
  echo "[✓] Red altosa_backend creada."
else
  echo "[✓] Red altosa_backend existente."
fi

ensure_env() {
  local key="$1" value="$2" current
  if grep -q "^${key}=" .env; then
    current="$(grep -m1 "^${key}=" .env | cut -d= -f2-)"
    if [ -z "$current" ]; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
      echo "[✓] ${key} completada en .env"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >> .env
    echo "[✓] ${key} agregada a .env"
  fi
}

log "Archivo .env"
if [ ! -f .env ]; then
  cat > .env <<EOF
POSTGRES_USER=altosa_admin
POSTGRES_PASSWORD=$(openssl rand -hex 32)
POSTGRES_DB=altosa
PGADMIN_EMAIL=admin@altosa.local
PGADMIN_PASSWORD=$(openssl rand -hex 24)
PGADMIN_PUBLIC_PORT=5050
PGADMIN_PUBLIC_DOMAIN=${PGADMIN_DOMAIN}
ALTOSA_API_KEY=$(openssl rand -hex 32)
ALTOSA_PUBLIC_URL_BASE=${PUBLIC_URL_BASE}
ALTOSA_PUBLIC_DOMAIN=${PUBLIC_DOMAIN}
# Kommo (opcional): completar para sincronizar plantillas
KOMMO_API_URL=
KOMMO_API_KEY=
# Meta (WhatsApp Commerce): catálogo para el mapeo de Retailer IDs.
# El token de System User se completa después; no se versiona.
META_CATALOG_ID=1524398256394561
META_ACCESS_TOKEN=
EOF
  chmod 600 .env
  echo "[✓] .env creado con secretos nuevos."
else
  ensure_env POSTGRES_USER altosa_admin
  ensure_env POSTGRES_DB altosa
  ensure_env POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  ensure_env PGADMIN_EMAIL admin@altosa.local
  ensure_env PGADMIN_PASSWORD "$(openssl rand -hex 24)"
  ensure_env PGADMIN_PUBLIC_PORT 5050
  ensure_env PGADMIN_PUBLIC_DOMAIN "$PGADMIN_DOMAIN"
  ensure_env ALTOSA_API_KEY "$(openssl rand -hex 32)"
  ensure_env ALTOSA_PUBLIC_URL_BASE "$PUBLIC_URL_BASE"
  ensure_env ALTOSA_PUBLIC_DOMAIN "$PUBLIC_DOMAIN"
  ensure_env KOMMO_API_URL ''
  ensure_env KOMMO_API_KEY ''
  ensure_env META_CATALOG_ID 1524398256394561
  ensure_env META_ACCESS_TOKEN ''
  chmod 600 .env
  echo "[✓] .env existente conservado y completado."
fi

set -a
# shellcheck source=/dev/null
source .env
set +a

: "${ALTOSA_API_KEY:?Falta ALTOSA_API_KEY en .env}"
: "${ALTOSA_PUBLIC_URL_BASE:?Falta ALTOSA_PUBLIC_URL_BASE en .env}"
: "${ALTOSA_PUBLIC_DOMAIN:?Falta ALTOSA_PUBLIC_DOMAIN en .env}"
[ "${#ALTOSA_API_KEY}" -ge 16 ] || fail "ALTOSA_API_KEY debe tener al menos 16 caracteres."
if [ -z "${META_ACCESS_TOKEN:-}" ]; then
  warn "META_ACCESS_TOKEN vacío: sync:meta-mappings no podrá leer el catálogo de Meta hasta configurarlo."
fi

log "Configurando entrypoint de pgAdmin en Traefik"
bash ./scripts/configure-traefik-pgadmin.sh "$PGADMIN_PUBLIC_PORT"

log "Descargando imágenes base (postgres/pgadmin)"
docker compose pull --ignore-pull-failures

log "Validando docker-compose"
docker compose config >/dev/null

log "Levantando PostgreSQL"
# La API se arranca DESPUÉS de las migraciones: el cliente Prisma selecciona
# todas las columnas del esquema y fallaría si la BD aún no las tiene.
docker compose up -d postgres

log "Esperando PostgreSQL"
for i in $(seq 1 60); do
  if docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[✓] PostgreSQL disponible."
    break
  fi
  [ "$i" -eq 60 ] && fail "PostgreSQL no respondió."
  sleep 2
done

log "Habilitando pgvector"
docker exec altosa-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
echo "[✓] pgvector listo."

log "Aplicando migración de Kommo (kommo_templates)"
bash ./scripts/apply-kommo-migration.sh

log "Aplicando migración de Meta (product_variants.meta_retailer_id)"
bash ./scripts/apply-meta-retailer-migration.sh

log "Construyendo y levantando servicios"
docker compose up -d --build

log "Esperando altosa-api"
for i in $(seq 1 60); do
  if docker exec altosa-api wget -qO- http://127.0.0.1:4100/health >/dev/null 2>&1; then
    echo "[✓] altosa-api responde /health."
    break
  fi
  [ "$i" -eq 60 ] && {
    docker logs --tail 100 altosa-api >&2 || true
    fail "altosa-api no respondió."
  }
  sleep 2
done

log "Conectando n8n a altosa_backend"
bash ./scripts/connect-n8n.sh

log "Healthcheck"
bash ./scripts/healthcheck.sh

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 15 "https://${ALTOSA_PUBLIC_DOMAIN}/health" >/dev/null 2>&1; then
    echo "[✓] API pública responde: https://${ALTOSA_PUBLIC_DOMAIN}/health"
  else
    warn "La API pública aún no responde en https://${ALTOSA_PUBLIC_DOMAIN}/health."
    warn "Revisa el DNS del subdominio, el certificado TLS y los logs de Traefik."
  fi
fi

cat <<EOF

============================================================
 ALTOSA Infrastructure desplegada
------------------------------------------------------------
 API URL:        https://${ALTOSA_PUBLIC_DOMAIN}
 Uploads base:   ${ALTOSA_PUBLIC_URL_BASE}
 pgAdmin:        http://IP_DEL_VPS:${PGADMIN_PUBLIC_PORT}
------------------------------------------------------------
 ALTOSA_API_KEY (copiar al .env.production del ERP):
 ${ALTOSA_API_KEY}
------------------------------------------------------------
 En el ERP configura:
   ALTOSA_API_URL=https://${ALTOSA_PUBLIC_DOMAIN}
   ALTOSA_API_KEY=${ALTOSA_API_KEY}
------------------------------------------------------------
 Plantillas Kommo: configura KOMMO_API_URL y KOMMO_API_KEY en .env
============================================================
EOF
