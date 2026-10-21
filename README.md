# Altosa Infrastructure V4

V4 publica **pgAdmin a través del Traefik existente**, sin dominio, usando un entrypoint dedicado (por defecto TCP/HTTP 5050).

## Arquitectura

- `http://IP_DEL_VPS:5050` -> Traefik -> pgAdmin
- Traefik existente -> n8n (routing de Hostinger se conserva)
- Traefik -> `https://ALTOSA_PUBLIC_DOMAIN` -> altosa-api:4100
- n8n + pgAdmin + altosa-api + PostgreSQL comparten `altosa_backend`
- PostgreSQL NO publica 5432
- El ERP Unyx consume `altosa-api` con `x-api-key`.

> Sin dominio, esta versión usa HTTP para pgAdmin. No envía credenciales de pgAdmin por HTTPS. Úsalo como configuración temporal; para producción se recomienda un hostname con TLS/Let's Encrypt o restringir el puerto 5050 por firewall/VPN.

## Instalación

### Desde Windows (recomendado)

```powershell
cd "D:\Trabajo\Unyx Solutions\Develop\Backends Clientes\altosa_infrastructure"
.\deploy.ps1 -VpsHost <ALTOSA_VPS_IP> -PublicDomain api.altosamobiliario.com
```

El wrapper sube el código (sin `.env` ni backups), ejecuta `install.sh` la
primera vez o `update.sh` si ya existe `.env`, y al final imprime:

```text
ALTOSA_API_URL=https://api.altosamobiliario.com
ALTOSA_API_KEY=<key>
```

Esos dos valores se copian al `.env.production` del ERP.

### En el VPS

```bash
cd /docker/altosa_infrastructure
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh api.altosamobiliario.com
```

El instalador:
1. conserva `.env` y completa las claves faltantes;
2. genera `ALTOSA_API_KEY` si no existe;
3. configura `ALTOSA_PUBLIC_URL_BASE` / `ALTOSA_PUBLIC_DOMAIN`;
4. crea `altosa_backend`;
5. guarda una copia inicial de `/docker/traefik/docker-compose.yml`;
6. añade `--entrypoints.pgadmin.address=:5050`;
7. reinicia Traefik;
8. construye y levanta PostgreSQL/pgvector, pgAdmin y altosa-api;
9. espera healthchecks y conecta n8n a `altosa_backend`.

Actualización (hace backup previo de BD + uploads):

```bash
sudo bash update.sh
sudo bash update.sh --no-backup
```

Para cambiar el dominio público después de instalado, edita
`ALTOSA_PUBLIC_DOMAIN` y `ALTOSA_PUBLIC_URL_BASE` en `.env` y ejecuta
`update.sh`. Luego actualiza `ALTOSA_API_URL` en el `.env.production` del ERP.

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

## API (altosa-api)

Servicio sobre la base de datos del cliente (`backend/`) con endpoints de lectura
y sincronización de productos, consumido por el backend del ERP Unyx (patrón BFF).
El contenedor solo expone el puerto 4100 dentro de `altosa_backend`; el acceso
público va por Traefik en `ALTOSA_PUBLIC_DOMAIN` (HTTPS) y requiere `x-api-key`.
La ruta `/uploads` es pública para servir las imágenes de variantes.

- Endpoints: `/health` (sin key) y `/api/v1/{products, products/:id, products/sku/:sku, categories, catalogs, locations, warranties, documents}`.
- Sincronización desde Contifico/ERP: `POST /api/v1/sync/products` (upsert idempotente por SKU de variante, máx. 100 ítems por lote). Ver `docs/integracion-contifico.md` en el repo del ERP.
- Reconciliación: `POST /api/v1/sync/products/deactivate` con `{ skus: [...] }` (máx. 500); desactiva variantes y el producto si se queda sin variantes activas.
- Seed offline desde un export del ERP: `pnpm seed:products -- data/contifico-products.json` (procesa en lotes de 100 y aplica `deactivateSkus` si viene en el export).
- Autenticación: header `x-api-key` con `ALTOSA_API_KEY` de `.env`.
- En `.env`: `ALTOSA_API_KEY=<openssl rand -hex 32>`, `ALTOSA_PUBLIC_URL_BASE=https://api.altosamobiliario.com` y `ALTOSA_PUBLIC_DOMAIN=api.altosamobiliario.com`.
- Build/levantar: `docker compose build api && docker compose up -d api` (o `./update.sh`).
- Health local: `./scripts/healthcheck.sh` (verifica PostgreSQL, pgvector, la API y la key).
- Prueba desde el VPS del ERP:
  ```bash
  curl -fsS https://api.altosamobiliario.com/health
  curl -fsS -H "x-api-key: <KEY>" "https://api.altosamobiliario.com/api/v1/products?page=1&pageSize=1"
  ```
- Esquema en Prisma: solo `prisma generate`, NUNCA `migrate` (las tablas las administra el pipeline n8n/`kb_sync_record` del cliente).
  - Excepción controlada: `kommo_templates`, `products.kommo_template_id` y `product_variants.kommo_template_id` se crean con `scripts/apply-kommo-migration.sh` (SQL idempotente; lo ejecutan `install.sh`/`update.sh`).
- Plantillas de Kommo: `GET /api/v1/kommo/templates?search=` y `POST /api/v1/kommo/sync-templates`. Configura `KOMMO_API_URL` y `KOMMO_API_KEY` en `.env`.

## Kommo (plantillas de chat)

Configura en el `.env` de Altosa:

```env
KOMMO_API_URL=https://altosa.kommo.com
KOMMO_API_KEY=<token de larga duración>
```

- Producción: `/docker/altosa_infrastructure/.env` (el compose lo pasa al contenedor `altosa-api`). Después ejecuta `sudo bash update.sh`.
- Desarrollo local: `backend/.env`; reinicia `pnpm dev`.
- El ERP **no** guarda este token: el frontend consulta el BFF del ERP, el ERP llama a `altosa-api` con `x-api-key`, y `altosa-api` llama a Kommo.
- Sincronización: `POST /api/v1/kommo/sync-templates` (desde la UI con el botón **Sincronizar** de la sección “Plantilla de Kommo” o directo con `x-api-key`).
- Búsqueda: `GET /api/v1/kommo/templates?search=...`.
- La API de Kommo devuelve solo las plantillas creadas por la integración actual; si una plantilla no aparece, revisa esa limitación/permisos.
- `product_variants.kommo_template_id` guarda la asociación variante → plantilla; n8n puede leerla con un JOIN a `kommo_templates`.

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
