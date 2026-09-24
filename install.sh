#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

echo "=== ALTOSA Infrastructure V4 ==="
echo "PostgreSQL + pgvector + pgAdmin behind existing Traefik + n8n private network"
echo

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker no está instalado."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose no está disponible."; exit 1; }

if ! docker network inspect altosa_backend >/dev/null 2>&1; then
  docker network create altosa_backend >/dev/null
  echo "[✓] Red altosa_backend creada."
else
  echo "[✓] Red altosa_backend existente."
fi

if [ ! -f .env ]; then
  cat > .env <<EOF
POSTGRES_USER=altosa_admin
POSTGRES_PASSWORD=$(openssl rand -hex 32)
POSTGRES_DB=altosa
PGADMIN_EMAIL=admin@altosa.local
PGADMIN_PASSWORD=$(openssl rand -hex 24)
PGADMIN_PUBLIC_PORT=5050
EOF
  chmod 600 .env
  echo "[✓] .env creado."
else
  grep -q '^PGADMIN_PUBLIC_PORT=' .env || echo 'PGADMIN_PUBLIC_PORT=5050' >> .env
  echo "[✓] .env existente conservado."
fi

set -a
source .env
set +a

echo "[+] Configurando entrypoint público de pgAdmin en Traefik..."
./scripts/configure-traefik-pgadmin.sh "$PGADMIN_PUBLIC_PORT"

echo "[+] Descargando imágenes..."
docker compose pull

echo "[+] Validando Compose..."
docker compose config >/dev/null

echo "[+] Levantando PostgreSQL y pgAdmin..."
docker compose up -d

echo "[+] Esperando PostgreSQL..."
for i in {1..45}; do
  if docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[✓] PostgreSQL disponible."
    break
  fi
  [ "$i" -eq 45 ] && { echo "ERROR: PostgreSQL no respondió."; exit 1; }
  sleep 2
done

docker exec altosa-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
echo "[✓] pgvector listo."

./scripts/connect-n8n.sh

echo
echo "=== INSTALACIÓN COMPLETADA ==="
echo "pgAdmin público vía Traefik: http://IP_DEL_VPS:${PGADMIN_PUBLIC_PORT}"
echo "PostgreSQL: privado en altosa_backend:5432"
echo "n8n: conectado a altosa_backend; routing existente conservado."
echo
docker compose ps
