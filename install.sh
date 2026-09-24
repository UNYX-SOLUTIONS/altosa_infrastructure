#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

echo "=== ALTOSA Infrastructure v2 ==="
command -v docker >/dev/null || { echo "ERROR: Docker no esta instalado"; exit 1; }
docker compose version >/dev/null || { echo "ERROR: Docker Compose no esta disponible"; exit 1; }

if ! docker network inspect altosa_backend >/dev/null 2>&1; then
  echo "[+] Creando red altosa_backend"
  docker network create altosa_backend >/dev/null
else
  echo "[✓] Red altosa_backend existente"
fi

if [[ ! -f .env ]]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  PGADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > .env <<ENVEOF
POSTGRES_USER=altosa_admin
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=altosa
PGADMIN_EMAIL=admin@altosa.com.ec
PGADMIN_PASSWORD=${PGADMIN_PASSWORD}
PGADMIN_HOST=pgadmin.example.com
ENVEOF
  chmod 600 .env
  echo "[!] .env creado. EDITE PGADMIN_HOST antes de publicar pgAdmin."
  echo "    Archivo: $(pwd)/.env"
fi

set -a; source .env; set +a
if [[ "${PGADMIN_HOST}" == "pgadmin.example.com" || -z "${PGADMIN_HOST}" ]]; then
  echo "ERROR: Configure PGADMIN_HOST en .env (ej. pgadmin.sudominio.com)"
  exit 1
fi

echo "[+] Descargando imagenes"
docker compose pull

echo "[+] Validando Compose"
docker compose config >/dev/null

echo "[+] Levantando PostgreSQL + pgAdmin"
docker compose up -d

echo "[+] Esperando PostgreSQL"
for i in {1..30}; do
  if docker exec altosa-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
  [[ $i -eq 30 ]] && { docker logs altosa-postgres --tail 100; exit 1; }
  sleep 2
done

echo "[+] Activando pgvector"
docker exec altosa-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"

N8N_CONTAINERS="$(docker ps --filter 'ancestor=docker.n8n.io/n8nio/n8n' --format '{{.Names}}')"
if [[ -z "$N8N_CONTAINERS" ]]; then
  echo "[!] No se detecto un contenedor n8n en ejecucion. Puede conectarlo luego con scripts/connect-n8n.sh"
else
  while IFS= read -r n8n; do
    [[ -z "$n8n" ]] && continue
    if docker inspect "$n8n" --format '{{json .NetworkSettings.Networks}}' | grep -q 'altosa_backend'; then
      echo "[✓] $n8n ya esta conectado a altosa_backend"
    else
      echo "[+] Conectando $n8n a altosa_backend"
      docker network connect altosa_backend "$n8n"
    fi
  done <<< "$N8N_CONTAINERS"
fi

echo ""
echo "=== INSTALACION COMPLETADA ==="
echo "PostgreSQL interno: altosa-postgres:5432"
echo "Base: $POSTGRES_DB"
echo "pgAdmin: https://$PGADMIN_HOST"
echo "Red: altosa_backend"
echo ""
docker compose ps
