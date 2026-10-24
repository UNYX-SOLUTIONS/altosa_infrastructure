#!/usr/bin/env bash
# ============================================================================
# ALTOSA Infrastructure - Actualización
#
# Uso:
#   sudo bash update.sh
#   sudo bash update.sh --no-backup
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"

SKIP_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --no-backup) SKIP_BACKUP=1 ;;
    -h|--help) sed -n '1,15p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nAVISO: %s\n' "$*" >&2; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || fail "No existe .env. Ejecuta install.sh primero."
if ! grep -q '^ALTOSA_API_KEY=.' .env \
  || ! grep -q '^ALTOSA_PUBLIC_URL_BASE=.' .env \
  || ! grep -q '^ALTOSA_PUBLIC_DOMAIN=.' .env; then
  fail "Faltan claves de altosa-api en .env. Ejecuta 'bash install.sh' una vez para completarlas."
fi

set -a
# shellcheck source=/dev/null
source .env
set +a

: "${ALTOSA_API_KEY:?Falta ALTOSA_API_KEY en .env}"
: "${ALTOSA_PUBLIC_URL_BASE:?Falta ALTOSA_PUBLIC_URL_BASE en .env}"
: "${ALTOSA_PUBLIC_DOMAIN:?Falta ALTOSA_PUBLIC_DOMAIN en .env}"
if [ -z "${META_ACCESS_TOKEN:-}" ]; then
  warn "META_ACCESS_TOKEN vacío: el mapeo Meta (sync:meta-mappings) no funcionará hasta configurarlo."
fi

docker network inspect altosa_backend >/dev/null 2>&1 || fail "No existe la red altosa_backend."

if [ "$SKIP_BACKUP" != 1 ]; then
  log "Backup previo (BD + uploads)"
  if ! bash ./backup.sh; then
    warn "El backup previo falló; se continúa con la actualización."
  fi
fi

log "Configurando entrypoint de pgAdmin en Traefik"
bash ./scripts/configure-traefik-pgadmin.sh "${PGADMIN_PUBLIC_PORT:-5050}"

log "Validando docker-compose"
docker compose config >/dev/null

log "Descargando imágenes base"
# --ignore-pull-failures: altosa-api se construye localmente (build:) y no
# existe en un registro; postgres/pgadmin sí se actualizan desde Docker Hub.
docker compose pull --ignore-pull-failures

log "Levantando PostgreSQL"
# La API se reconstruye DESPUÉS de aplicar las migraciones: el cliente Prisma
# selecciona todas las columnas del esquema y fallaría contra una BD sin la
# columna nueva. Mientras migra, la API anterior sigue sirviendo.
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

log "Aplicando migración de Kommo (kommo_templates)"
bash ./scripts/apply-kommo-migration.sh

log "Aplicando migración de Meta (product_variants.meta_retailer_id)"
bash ./scripts/apply-meta-retailer-migration.sh

log "Reconstruyendo y levantando altosa-api"
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

log "Reconectando n8n"
bash ./scripts/connect-n8n.sh

log "Healthcheck"
bash ./scripts/healthcheck.sh

cat <<EOF

============================================================
 ALTOSA Infrastructure actualizada
------------------------------------------------------------
 API URL:   https://${ALTOSA_PUBLIC_DOMAIN}
 Uploads:   ${ALTOSA_PUBLIC_URL_BASE}
------------------------------------------------------------
 Si cambió ALTOSA_API_KEY, actualiza también el
 ALTOSA_API_KEY del .env.production del ERP y reinicia su backend.
============================================================
EOF
