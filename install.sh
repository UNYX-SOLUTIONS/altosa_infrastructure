#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
echo "=== ALTOSA Infrastructure | PostgreSQL + pgvector + pgAdmin ==="
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker no está instalado."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose no está disponible."; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl no está instalado."; exit 1; }
if [ ! -f .env ]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  PGADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > .env <<ENVEOF
POSTGRES_USER=altosa_admin
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=altosa
PGADMIN_EMAIL=admin@altosa.com.ec
PGADMIN_PASSWORD=${PGADMIN_PASSWORD}
ENVEOF
  chmod 600 .env
  echo "✓ .env creado. Guarde sus credenciales: $(pwd)/.env"
else
  echo "✓ .env existente; no se modificará."
fi
set -a; source .env; set +a
docker compose pull
docker compose config >/dev/null
docker compose up -d
echo "Esperando PostgreSQL..."
for i in {1..30}; do
  if docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && { docker logs altosa-postgres --tail 100; exit 1; }
  sleep 2
done
docker exec altosa-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"
echo "✓ Instalación completada"
docker compose ps
