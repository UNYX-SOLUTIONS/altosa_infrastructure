# Altosa Infrastructure V4

V4 publica **pgAdmin a través del Traefik existente**, sin dominio, usando un entrypoint dedicado (por defecto TCP/HTTP 5050).

## Arquitectura

- `http://IP_DEL_VPS:5050` -> Traefik -> pgAdmin
- Traefik existente -> n8n (routing de Hostinger se conserva)
- n8n + pgAdmin + PostgreSQL comparten `altosa_backend`
- PostgreSQL NO publica 5432

> Sin dominio, esta versión usa HTTP para pgAdmin. No envía credenciales de pgAdmin por HTTPS. Úsalo como configuración temporal; para producción se recomienda un hostname con TLS/Let's Encrypt o restringir el puerto 5050 por firewall/VPN.

## Instalación

```bash
cd /docker/altosa_infrastructure
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh
```

El instalador:
1. conserva `.env`;
2. crea `altosa_backend`;
3. guarda una copia inicial de `/docker/traefik/docker-compose.yml`;
4. añade `--entrypoints.pgadmin.address=:5050`;
5. reinicia Traefik;
6. levanta PostgreSQL/pgvector y pgAdmin;
7. conecta n8n a `altosa_backend`.

## Acceso

```text
http://IP_DEL_VPS:5050
```

En pgAdmin, registrar PostgreSQL con:

- Host: `altosa-postgres`
- Port: `5432`
- Database: `altosa` (o el valor de `POSTGRES_DB`)
- User: valor de `POSTGRES_USER`
- Password: valor de `POSTGRES_PASSWORD`

## Firewall

El VPS/proveedor debe permitir TCP 5050 para poder acceder desde Internet.

## Importante

El Traefik de Hostinger usa `network_mode: host`; por eso el entrypoint escucha directamente en el host. pgAdmin publica un puerto Docker aleatorio solo para que el provider Docker de Traefik pueda alcanzarlo siguiendo el mismo patrón que la instalación actual de n8n.

No ejecutes `docker compose down -v` si quieres conservar la información.

## API interna (altosa-api)

Servicio de solo lectura sobre la base de datos del cliente (`backend/`), consumido por el backend del ERP Unyx (patrón BFF). No publica puertos: solo es alcanzable dentro de la red Docker `altosa_backend`.

- Endpoints: `/health` (sin key) y `/api/v1/{products, products/:id, products/sku/:sku, categories, catalogs, locations, warranties, documents}`.
- Autenticación: header `x-api-key` con `ALTOSA_API_KEY` de `.env`.
- En `.env` agregar: `ALTOSA_API_KEY=<openssl rand -hex 32>` (la misma clave se configura en el backend del ERP).
- Build/levantar: `docker compose build api && docker compose up -d api` (o `./update.sh`).
- Prueba: `docker exec <contenedor-backend-erp> wget -qO- --header='x-api-key: <KEY>' http://altosa-api:4100/health`
- Esquema en Prisma: solo `prisma generate`, NUNCA `migrate` (las tablas las administra el pipeline n8n/`kb_sync_record` del cliente).

### Desarrollo local del API

```powershell
cd backend
pnpm install
pnpm prisma generate
# .env local: PORT=4199, DATABASE_URL=postgresql://altosa_admin:<pass>@localhost:5499/altosa, API_KEY=<clave de prueba>
pnpm dev
```

Restaurar el dump localmente (contenedor temporal de pgvector/pg16):

```powershell
docker run -d --name altosa-restore --restart unless-stopped -e POSTGRES_USER=altosa_admin -e POSTGRES_PASSWORD=temp_restore -e POSTGRES_DB=altosa -p 5499:5432 -v "<ruta sql>:/dump" pgvector/pgvector:pg16
docker exec altosa-restore psql -U altosa_admin -d altosa -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;"
docker exec altosa-restore pg_restore -U altosa_admin -d altosa --no-owner --role=altosa_admin /dump/altosa_2026-10-15.schema.backup
# Importante: avanza las secuencias de identidad (si no, los INSERT nuevos chocan con ids existentes):
docker exec altosa-restore psql -U altosa_admin -d altosa -c "SELECT setval(pg_get_serial_sequence('products','id_producto'), (SELECT max(id_producto) FROM products)); SELECT setval(pg_get_serial_sequence('product_variants','id_variante'), (SELECT max(id_variante) FROM product_variants)); SELECT setval(pg_get_serial_sequence('documents','id'), (SELECT max(id) FROM documents));"
```
