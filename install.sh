#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

echo "=== ALTOSA Infrastructure V3 ==="
echo "PostgreSQL + pgvector + pgAdmin + private n8n network"
echo

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker no está instalado."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose no está disponible."; exit 1; }

if ! docker network inspect altosa_backend >/dev/null 2>&1; then
  echo "[+] Creando red altosa_backend..."
  docker network create altosa_backend >/dev/null
else
  echo "[✓] Red altosa_backend existente."
fi

if [ ! -f .env ]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  PGADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > .env <<EOF
POSTGRES_USER=altosa_admin
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=altosa
PGADMIN_EMAIL=admin@altosa.local
PGADMIN_PASSWORD=${PGADMIN_PASSWORD}
EOF
  chmod 600 .env
  echo "[✓] .env creado. Guarda sus credenciales: $(pwd)/.env"
else
  echo "[✓] .env existente conservado."
fi

echo "[+] Descargando imágenes..."
docker compose pull

echo "[+] Validando Compose..."
docker compose config >/dev/null

echo "[+] Levantando PostgreSQL y pgAdmin..."
docker compose up -d

set -a
source .env
set +a

echo "[+] Esperando PostgreSQL..."
for i in {1..45}; do
  if docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[✓] PostgreSQL disponible."
    break
  fi
  if [ "$i" -eq 45 ]; then
    echo "ERROR: PostgreSQL no respondió."
    docker logs altosa-postgres --tail 100
    exit 1
  fi
  sleep 2
done

echo "[+] Activando pgvector..."
docker exec altosa-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
echo "[✓] pgvector listo."

echo "[+] Detectando y conectando n8n..."
./scripts/connect-n8n.sh

echo
echo "=== INSTALACIÓN COMPLETADA ==="
echo "PostgreSQL: privado en altosa_backend:5432"
echo "pgAdmin: solo VPS en 127.0.0.1:5050"
echo "n8n: conectado a altosa_backend; su Traefik actual no se modifica."
echo
docker compose ps
