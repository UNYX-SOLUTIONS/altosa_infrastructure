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

## Archivos .env (local vs VPS)

Hay dos entornos y cada uno lee su propio archivo. **No son intercambiables:**

| Archivo | Dónde vive | Lo lee | Para qué |
|---|---|---|---|
| `backend/.env` | tu máquina, junto al backend | `pnpm dev`, scripts `tsx` y Prisma CLI | Desarrollo local |
| `backend/.env.example` | repo | — | Plantilla del entorno local |
| `.env` (raíz) | VPS `/docker/altosa_infrastructure/.env` | `docker compose`, `install.sh`, `update.sh` y cron | Producción/Docker |
| `.env.example` (raíz) | repo | — | Plantilla del entorno Docker/producción |

- `pnpm dev` lee **solo** `backend/.env`; Docker lee **solo** el `.env` de la raíz.
- El `.env` de la raíz no existe en tu copia local: se crea en el VPS y no se sube con los deploys.
- El `backend/.env` no se sube y no lo usa Docker. El Dockerfile no copia `.env` y `.dockerignore` lo excluye; el contenedor recibe todo por `environment:` del compose desde la raíz.
- El contenedor escucha en `4100`; tu `backend/.env` local usa `4199` (puedes cambiarlo).

Nombres que cambian en la frontera de Docker:

| En la raíz (VPS) | En el contenedor / local |
|---|---|
| `ALTOSA_API_KEY` | `API_KEY` |
| `ALTOSA_PUBLIC_URL_BASE` | `PUBLIC_URL_BASE` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `DATABASE_URL` (la arma el compose) |
| `KOMMO_API_URL`, `KOMMO_API_KEY` | igual |
| `META_CATALOG_ID`, `META_ACCESS_TOKEN`, `META_API_VERSION` | igual |
| `PGADMIN_*` | solo VPS |

Diferencias deliberadas entre las dos plantillas:

- **Solo raíz**: `POSTGRES_*`, `PGADMIN_*`, `ALTOSA_PUBLIC_DOMAIN` (infraestructura/Traefik).
- **Solo local**: `NODE_ENV`, `PORT`, `UPLOAD_DIR`, `DATABASE_URL`, `API_KEY`, `PUBLIC_URL_BASE`.
- **Común a ambos**: `KOMMO_API_URL`, `KOMMO_API_KEY`, `META_CATALOG_ID`, `META_ACCESS_TOKEN`, `META_API_VERSION`.
- Compose fija en producción `NODE_ENV=production`, `PORT=4100` y `UPLOAD_DIR=/data/uploads`; por eso no están en la raíz.

Verificación de plantillas:

```bash
bash scripts/check-env-examples.sh
```

Compara las claves comunes, avisa de secretos vacíos y falla si falta una clave o si `KOMMO_API_URL`, `META_CATALOG_ID` o `META_API_VERSION` no coinciden. No imprime secretos.

- El `API_KEY` local (`backend/.env`) debe coincidir con el `ALTOSA_API_KEY` del `.env` local del ERP. En el VPS, el `ALTOSA_API_KEY` del ERP debe coincidir con el de la raíz.
- `META_*` está en ambos si quieres probar el selector en local y en producción; es el mismo token de System User. Si no pruebas Meta en local, deja `META_ACCESS_TOKEN` vacío: los productos funcionan y las rutas de Meta responden `503 META_NOT_CONFIGURED`.
- Los `PGADMIN_*` solo viven en la raíz; no van al backend.
- Nunca subas un `.env` real. Ambos están en `.gitignore`; usa `chmod 600` en el VPS y no los pegues en capturas ni en el chat.

Para un entorno local nuevo:

```powershell
Copy-Item backend\.env.example backend\.env
# edita DATABASE_URL, API_KEY y, si aplica, KOMMO_*/META_*
```

> Si ya tienes `backend/.env`, **no lo copies encima**: usa `.env.example` solo como referencia y agrega las claves que falten.
>
> Tampoco copies `.env.example` (raíz) sobre un `.env` existente en el VPS: cambiaría la contraseña de Postgres, la de pgAdmin y la API key. Para un entorno nuevo, deja los secretos vacíos y `install.sh` los genera.

El `.env` de la raíz lo crea/completa `install.sh`; las actualizaciones lo conservan.

### Cambiar variables en producción

Solo se edita `/docker/altosa_infrastructure/.env` en el VPS:

```bash
ssh root@<ALTOSA_VPS_IP>
cd /docker/altosa_infrastructure
nano .env
chmod 600 .env
sudo bash update.sh --api-only
bash scripts/healthcheck.sh
```

- `--api-only` recrea `altosa-api` con las nuevas variables; no toca pgAdmin/PostgreSQL/Traefik.
- Si cambias `ALTOSA_API_KEY`, actualiza también `ALTOSA_API_KEY` en `/opt/unyx-erp/.env.production` (o `.env.deploy`) y redespliega el ERP.
- Si cambias `PGADMIN_*`, usa el update completo o recrea pgAdmin; `--api-only` no lo toca.
- Si cambias `POSTGRES_PASSWORD`, no basta con el `.env`: la contraseña real ya está en el volumen de Postgres; hay que cambiarla en la base o recrear el volumen (con backup).

## API (altosa-api)

Servicio sobre la base de datos del cliente (`backend/`) con endpoints de lectura
y sincronización de productos, consumido por el backend del ERP Unyx (patrón BFF).
El contenedor solo expone el puerto 4100 dentro de `altosa_backend`; el acceso
público va por Traefik en `ALTOSA_PUBLIC_DOMAIN` (HTTPS) y requiere `x-api-key`.
La ruta `/uploads` es pública para servir las imágenes de variantes.

- Endpoints: `/health` (sin key) y `/api/v1/{products, products/:id, products/sku/:sku, categories, catalogs, locations, warranties, documents, meta/catalog/search, meta/catalog/item}`.
- Sincronización desde Contifico/ERP: `POST /api/v1/sync/products` (upsert idempotente por SKU de variante, máx. 100 ítems por lote). Ver `docs/integracion-contifico.md` en el repo del ERP.
- Reconciliación: `POST /api/v1/sync/products/deactivate` con `{ skus: [...] }` (máx. 500); desactiva variantes y el producto si se queda sin variantes activas.
- Seed offline desde un export del ERP: `pnpm seed:products -- data/contifico-products.json` (procesa en lotes de 100 y aplica `deactivateSkus` si viene en el export).
- Backfill de Retailer IDs de Meta (WhatsApp Commerce): `pnpm backfill:meta-retailer-ids -- data/meta-retailer-ids.csv --dry-run` (CSV con encabezado `sku,retailer_id` o JSON; omite `--dry-run` para escribir). Sin mapeo, n8n usa `sku` como fallback.
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
  - Excepciones controladas (SQL idempotente; lo ejecutan `install.sh`/`update.sh`):
    - `kommo_templates`, `products.kommo_template_id` y `product_variants.kommo_template_id` con `scripts/apply-kommo-migration.sh`.
    - `product_variants.meta_retailer_id` y `product_variants.meta_mapping_locked` con `scripts/apply-meta-retailer-migration.sh`.
      - `meta_retailer_id` es único (índice funcional case-insensitive); el script detecta duplicados y falla antes de crear el índice.
    - `product_variants.contifico_id` y `product_variants.contifico_sku` con `scripts/apply-contifico-migration.sh`.
      - `contifico_id` es único (índice funcional case-insensitive); el script detecta duplicados y falla antes de crear el índice.
- Plantillas de Kommo: `GET /api/v1/kommo/templates?search=` y `POST /api/v1/kommo/sync-templates`. Configura `KOMMO_API_URL` y `KOMMO_API_KEY` en `.env`.
- Catálogo Meta (selector de mapeo): `GET /api/v1/meta/catalog/search?q=&limit=` y `GET /api/v1/meta/catalog/item?retailerId=`. Configura `META_CATALOG_ID`, `META_ACCESS_TOKEN` y, opcionalmente, `META_API_VERSION` en `.env`.
  - Creación plana desde el ERP: el alta con `syncExternals=true` publica la variante con `POST /{catalog_id}/products` y guarda el `meta_retailer_id` con `meta_mapping_locked=true`. Requiere permiso `catalog_management`; si Meta falla, el producto se crea igual en Altosa y la variante queda pendiente de mapeo manual (se registra una advertencia, no se bloquea el alta).
- **Contifico (Altosa es la única dueña del token y del cliente)**: `GET /api/v1/contifico/status`, `/search`, `/products`, `/products/:id`, `/categories`; `POST /api/v1/contifico/import` y `POST /api/v1/contifico/sync`. Configura `CONTIFICO_API_URL`, `CONTIFICO_API_KEY` y, opcionalmente, `CONTIFICO_API_TOKEN` en `.env`.
  - Sync nativo desde el VPS de Altosa: `bash scripts/contifico-sync.sh --dry-run` (no escribe) y `bash scripts/contifico-sync.sh --apply`. Opciones: `--match-by-name`, `--create-missing`, `--prune`, `--only-sku=SKU`.
  - El ERP ya no tiene `CONTIFICO_API_KEY`: solo llama a Altosa. Las rutas `/api/v1/integrations/contifico/*` del ERP son un proxy de compatibilidad.
- Referencias planas de Contifico: `product_variants.contifico_id` y `contifico_sku`, únicas por variante. Altosa crea/actualiza/desactiva el producto plano en Contifico en el alta/edición/borrado desde el ERP (`writeThroughContifico`).
- Ingesta inversa: `GET /api/v1/external/pending?limit=&search=&source=`, `GET /api/v1/external/links` y `POST /api/v1/external/import`. La bandeja combina Meta + Contifico dentro de Altosa; la importación crea el producto padre agrupado por nombre base, una variante por ítem, con `is_active=false`, y guarda ambos IDs externos cuando el mismo ítem existe en las dos fuentes.

## Kommo (plantillas de chat)

Configura en el `.env` de Altosa:

```env
KOMMO_API_URL=https://altosa.kommo.com
KOMMO_API_KEY=<token de larga duración>
```

- Producción: `/docker/altosa_infrastructure/.env` (el compose lo pasa al contenedor `altosa-api`). Después ejecuta `sudo bash update.sh`.
- Desarrollo local: `backend/.env`; reinicia `pnpm dev`.
- El ERP **no** guarda este token: el frontend consulta el BFF del ERP, el ERP llama a `altosa-api` con `x-api-key`, y `altosa-api` llama a Kommo.
- Sincronización: `POST /api/v1/kommo/sync-templates` (desde la UI con el botón **Sincronizar** del selector de plantilla de la variante, o directo con `x-api-key`). Hace upsert; **no desactiva automáticamente** las plantillas ausentes.
- Búsqueda: `GET /api/v1/kommo/templates?search=&limit=`.
- La API de Kommo devuelve solo las plantillas creadas por la integración actual; si una plantilla no aparece, revisa esa limitación/permisos.
- `product_variants.kommo_template_id` guarda la asociación variante → plantilla; n8n puede leerla con un JOIN a `kommo_templates`.

## Sincronización, mapeo Meta y operación

### Capas de verdad (no un único dueño)

```
Contifico (histórico + stock)
   ▲  write-back / sync nativo (Altosa es la única dueña del token)
   │
Altosa API + PostgreSQL (catálogo, integraciones y mapeos)
   ▲  x-api-key (solo API Altosa)
   │
ERP Unyx (administración, aprobación y UI)
   │
   └──► Meta Catalog (canal WhatsApp, vía Altosa)
```

- **Contifico** conserva el histórico y es la referencia de stock. **Altosa** administra el catálogo, ejecuta el sync y escribe de vuelta los campos soportados: nombre, descripción comercial, categoría/línea, estado activo y precio/descripción de la variante principal. El ERP solo envía la operación a Altosa.
- **Stock**: lo sincroniza Altosa desde Contifico; no se edita desde el ERP.
- **Imagen/thumbnail**: la API de Contifico no permite escribirla; se guarda en local/Altosa y el sync **preserva la imagen del ERP** si ya existe. La imagen de Contifico solo se usa para productos/variantes nuevos que no tengan una.
- **Variantes extra**: se crean en Altosa; Contifico no las conoce (limitación de su API). El SKU de una variante mapeada a Contifico está bloqueado en Altosa/ERP; se cambia en Contifico o se quita el mapeo.
- **Aprobación**: `isActive` y `validation` son del ERP. Los productos que entran desde Contifico (incluido "Agregar desde Contifico") nacen inactivos y `PENDIENTE`; el equipo los revisa, aprueba y activa antes de que lleguen a n8n/Meta.
- **Estado activo**: el sync conserva el `isActive` del producto y de cada variante del ERP. Si Contifico difiere, lo registra en el log para revisión; no reactiva nada. El estado de la variante se propaga a Altosa, así que n8n no ofrece variantes inactivas.
- **Altosa DB** es la base de integración que leen n8n y Kommo. `product_variants.sku` es el código interno y **no se modifica** para Meta.
- **Meta Catalog** identifica cada ítem con su propio `retailer_id` (ej. `WC-240482`). `product_variants.meta_retailer_id` guarda ese mapeo; n8n usa `COALESCE(meta_retailer_id, sku)`.
- **Mapeo manual vs sync**: `meta_mapping_locked = true` marca un mapeo hecho desde la UI o con backfill. El sync y el backfill omiten esas variantes (salvo `--force` en el backfill). Asignar o quitar desde la UI deja la variante bloqueada; "Restaurar sync automático" la desbloquea y deja `meta_retailer_id = NULL`.
- **Keywords**: se editan en el ERP, pero Altosa no tiene columna ni el workflow las usa todavía. Si la IA debe buscar por keywords, hay que mapearlas.
- **Subcategoría/taxonomía**: el ERP puede moverla; el sync la propaga a Altosa con `updateTaxonomy` solo cuando cambia explícitamente, y el sync masivo de Contifico no la pisa.
- **Meta (contenido)**: la tarjeta se renderiza con precio, imagen y disponibilidad del catálogo de Meta. El mapeo solo resuelve identidad; escribir contenido a Meta queda para una fase posterior (el catálogo actual parece externo, `WC-...`).
- **`--prune`**: no se usa en cron. La desactivación normal se hace desde el ERP y se propaga vía Altosa; `--prune` es una reconciliación manual/reporte para SKUs que ya no vienen de Contifico.

### Propiedad de campos

| Campo | Se edita en | Write-back / efecto |
|---|---|---|
| SKU producto / variante principal | Contifico | Bloqueado en Altosa/ERP; el sync lo refleja |
| Nombre, descripción comercial, categoría/línea, estado | ERP | Altosa → `PATCH /producto/{id}` en Contifico |
| Precio y descripción de la variante principal | ERP | Altosa → `PATCH /producto/{id}` (`pvp1`, `descripcion`) |
| Stock | Contifico | Solo lectura en el ERP; se refleja en Altosa |
| Imagen/thumbnail | ERP/local + Altosa | Contifico es read-only; el sync preserva la imagen del ERP |
| Variantes extra | ERP/local + Altosa | No se crean en Contifico (limitación API) |
| `keywords` | ERP | Solo local; no está en Altosa ni en el workflow |
| Subcategoría/taxonomía | ERP | `updateTaxonomy` a Altosa cuando cambia explícitamente |
| Plantilla Kommo, mapeo Meta | ERP/Altosa | No se escriben a Contifico |
| Precio/imagen/disponibilidad de la tarjeta Meta | Meta | Pendiente de fase de contenido Meta |


### Sincronizar el mapeo Meta -> Altosa

Con un export del catálogo (recomendado para revisar antes):

```bash
cd backend
pnpm sync:meta-mappings -- --file data/meta-catalog.json --dry-run --report data/meta-report.csv
pnpm sync:meta-mappings -- --file data/meta-catalog.json --match-by-name --dry-run --report data/meta-report.csv
pnpm sync:meta-mappings -- --file data/meta-catalog.json --match-by-name --apply --report data/meta-report.csv
```

Directo contra Graph API (requiere `META_CATALOG_ID` y `META_ACCESS_TOKEN` en el entorno; opcional `META_API_VERSION`, default `v26.0`):

```bash
META_CATALOG_ID=1524398256394561 META_ACCESS_TOKEN=<token> \
  pnpm sync:meta-mappings -- --apply --match-by-name --report data/meta-report.csv
```

Por defecto solo cruza por SKU/custom labels (determinista). `--match-by-name` habilita el cruce por nombre único (o nombre + color); revisar siempre el reporte antes de aplicar. Lo ambiguo, sin match o conflictivo se reporta y **no se escribe**. Solo actualiza `meta_retailer_id`; nunca SKU, precio ni otros campos. Sin `--apply` es dry-run. Los `retailer_id` ya mapeados se reportan como `already_ok` y no se vuelven a tocar. Si el ítem del catálogo ya está mapeado a una variante bloqueada, se reporta como `already_ok` con detalle "mapeo manual bloqueado"; las variantes bloqueadas sin ID no se proponen, y el sync nunca las sobrescribe ni libera.

Mapeo manual/backfill para excepciones:

```bash
pnpm backfill:meta-retailer-ids -- data/meta-retailer-ids.csv --dry-run
pnpm backfill:meta-retailer-ids -- data/meta-retailer-ids.csv
pnpm backfill:meta-retailer-ids -- data/meta-retailer-ids.csv --force
```

El CSV lleva encabezado `sku,retailer_id`. Si un `retailer_id` ya pertenece a otro SKU, el script se detiene. `--force` reasigna solo dueños no bloqueados; si el dueño está bloqueado, no se toca ni con `--force` (desbloquéalo desde el ERP). Las variantes bloqueadas se omiten por defecto; `--force` actualiza la variante objetivo y la deja bloqueada.

### Selector de catálogo Meta desde el ERP

El ERP consulta estos endpoints a través de su BFF autenticado; el navegador nunca recibe el token de Meta.

- `GET /api/v1/meta/catalog/search?q=PC155&limit=20`: busca por `retailer_id` o nombre normalizado (sin tildes, case-insensitive). `q` requiere 2–80 caracteres; `limit` máximo 50. Devuelve `{ success: true, data: { items: [{ retailerId, name, imageUrl, price, availability, visibility, url }] } }`.
- `GET /api/v1/meta/catalog/item?retailerId=WC-240482`: devuelve el ítem exacto o `404 META_ITEM_NOT_FOUND`.
- Sin `META_CATALOG_ID`/`META_ACCESS_TOKEN`: `503 META_NOT_CONFIGURED` (el resto del API sigue funcionando).
- Errores de Meta: `502 META_API_ERROR`. El cliente del API pagina con `paging.next` validando que sea `https://graph.facebook.com`, con timeout de 25 s y caché en memoria de 5 minutos. Las búsquedas tienen un límite adicional de 120 solicitudes cada 15 minutos.
- Seguridad: el token se envía solo en `Authorization: Bearer`, nunca en la URL, en la respuesta HTTP ni en logs. No hardcodear el token; rotarlo si se expone.

Diagnóstico de variantes activas sin mapeo (n8n usará el SKU como fallback y Meta puede devolver `131009`):

```sql
SELECT pv.sku, p.producto
FROM product_variants pv
JOIN products p ON p.id_producto = pv.id_producto
WHERE pv.is_active AND p.is_active AND pv.meta_retailer_id IS NULL
ORDER BY pv.sku;
```

Integridad del mapeo (ambas consultas deben devolver 0 filas):

```sql
-- Dos variantes con el mismo SKU rompen el enriquecimiento por SKU.
SELECT sku, count(*) FROM product_variants
WHERE sku IS NOT NULL GROUP BY sku HAVING count(*) > 1;

-- Dos variantes con el mismo retailer_id: el carrito no puede desambiguar color/precio.
SELECT MIN(meta_retailer_id) AS ejemplo, count(*) FROM product_variants
WHERE meta_retailer_id IS NOT NULL
GROUP BY LOWER(TRIM(meta_retailer_id)) HAVING count(*) > 1;
```

### Contenido del catálogo (precio/stock/imagen)

Hay dos caminos; hay que elegir uno:

1. **Altosa publica el catálogo a Meta** (recomendado a mediano plazo): `retailer_id = sku`, y un job envía precio/disponibilidad/imagen con `POST /{catalog_id}/items_batch`. El mapeo deja de ser necesario para productos nuevos.
2. **El catálogo lo administra otra fuente** (WooCommerce/Commerce Manager): agregar `custom_label_0 = sku` en el feed y correr `sync:meta-mappings` periódicamente. Sin esa marca, el cruce depende del nombre y requiere revisión. En este modo, comparar periódicamente precio/stock/imagen contra Altosa: si Contifico cambia un precio, Meta seguirá mostrando el anterior hasta que se actualice el feed.

### Orden de despliegue

1. **Altosa**: `sudo bash update.sh` (o `install.sh` la primera vez). Ahora aplica las migraciones **antes** de reconstruir `altosa-api`.
   - Solo API, sin recrear pgAdmin/PostgreSQL ni reiniciar Traefik: `sudo bash update.sh --api-only`.
2. Verifica: `bash scripts/healthcheck.sh` (columnas `meta_retailer_id`/`meta_mapping_locked`, índice, API con variantes y plantillas).
3. **ERP**: `sudo bash deploy/deploy-prod.sh` (o `deploy/deploy-test.sh`). El ERP ya no compila el sync de Contifico; solo el backfill de mapeos `dist/scripts/backfill-altosa-mappings.js`.
4. Configura `CONTIFICO_API_KEY` en el `.env` de Altosa (el ERP ya no lo tiene) y corre `bash scripts/contifico-sync.sh --dry-run --match-by-name` antes del `--apply`.
5. Configura `META_ACCESS_TOKEN` en el `.env` de Altosa y corre el mapeo en dry-run; revisa el CSV y aplica.
6. Instala los cron (abajo) cuando el reporte esté limpio.

### Programación recomendada (VPS)

Los scripts de Altosa se ejecutan dentro del contenedor; el wrapper de Contifico ahora vive en el VPS de Altosa:

```bash
# Contifico -> Altosa cada 15 min; el sync es idempotente.
# Sin --prune: solo actualiza/crea lo que ya existe en Altosa.
*/15 * * * * flock -n /tmp/altosa-contifico.lock bash -lc 'cd /docker/altosa_infrastructure && bash scripts/contifico-sync.sh --apply --match-by-name' >> /var/log/altosa-contifico.log 2>&1

# Reconciliación semanal SOLO REPORTE: muestra SKUs que ya no vienen de Contifico.
# No desactiva: la desactivación se hace desde el ERP y se propaga vía Altosa.
0 4 * * 0 flock -n /tmp/altosa-prune.lock bash -lc 'cd /docker/altosa_infrastructure && bash scripts/contifico-sync.sh --dry-run --prune' >> /var/log/altosa-contifico-prune.log 2>&1

# Meta -> Altosa una vez al día. El token se lee del entorno del host y se pasa
# por nombre a docker exec (no aparece en la línea de comandos).
# Requiere META_CATALOG_ID y META_ACCESS_TOKEN en /docker/altosa_infrastructure/.env (chmod 600).
0 3 * * * flock -n /tmp/altosa-meta.lock sh -c 'set -a; . /docker/altosa_infrastructure/.env; set +a; docker exec -e META_CATALOG_ID -e META_ACCESS_TOKEN altosa-api node dist/scripts/sync-meta-mappings.js --apply --report /tmp/meta-report.csv && docker cp altosa-api:/tmp/meta-report.csv /var/log/altosa-meta-report.csv' >> /var/log/altosa-meta.log 2>&1
```

- `META_CATALOG_ID`/`META_ACCESS_TOKEN`/`META_API_VERSION` se pasan al contenedor `altosa-api` desde el `.env` del compose (necesarios para el selector de la UI). El cron puede seguir pasándolos por nombre a `docker exec` o usar los del contenedor.
- El cron de Meta usa solo cruces deterministas (SKU/custom labels). Si el catálogo no los trae, haz el mapeo inicial con `--match-by-name --dry-run`, revisa el CSV y aplica; el cron seguirá reportando los no mapeados.
- En el VPS sin Node/pnpm, el backfill manual se puede ejecutar dentro del contenedor:
  `docker cp data/meta-retailer-ids.csv altosa-api:/tmp/ && docker exec altosa-api node dist/scripts/backfill-meta-retailer-ids.js /tmp/meta-retailer-ids.csv --dry-run`
- Los scripts son idempotentes; si un cron se solapa, `flock` evita la doble ejecución.
- Si `scripts/contifico-sync.sh` termina con código distinto de 0, revisa el JSON de respuesta y el log de `altosa-api`; el sync es idempotente y se puede reintentar.
- Alertar si: falla el cron, `failed > 0`, aparecen SKUs sin mapeo nuevos, o Meta responde `131009`.

### Checklist de seguridad para producción

- [ ] **n8n / Meta**: reemplazar `META_VERIFY_TOKEN` y `META_APP_SECRET` (los placeholders del workflow desactivan la validación de firma). Sin esto, cualquiera puede inyectar pedidos falsos al webhook.
- [ ] **n8n**: guardar el token de Meta en la credencial (nunca en el JSON del workflow). Usar token permanente de System User y rotarlo si se expone.
- [ ] **n8n**: path de webhooks no adivinable (sufijo aleatorio) y, si Kommo lo permite, header secreto; el webhook de Kommo no tiene firma nativa.
- [ ] **Postgres**: crear un rol de solo lectura para n8n (`GRANT SELECT` sobre products, product_variants, kommo_templates, subcategories, categories). n8n no necesita escribir en la BD.
- [ ] **pgAdmin**: no exponerlo a Internet sin allowlist de IP; es un panel de administración de la BD completa.
- [ ] **API**: mantener `altosa-api` solo en la red `altosa_backend`, rotar `ALTOSA_API_KEY` y usar HTTPS vía Traefik. El API nunca debe publicar el puerto 4100.
- [ ] **Migraciones**: nunca `prisma migrate`; solo los SQL idempotentes de `prisma/sql/` (los aplica `install.sh`/`update.sh` **antes** de arrancar la API).
- [ ] **Backups**: verificar restauración periódica de `backup.sh`; los backups contienen datos de clientes y la API key.
- [ ] **Tokens**: no imprimirlos en logs, reportes ni notas de Kommo. `sync:meta-mappings` y el cliente Meta los envían solo en `Authorization: Bearer`.

### Verificación después de desplegar

```bash
bash scripts/healthcheck.sh
# Debe mostrar OK de /health, /api/v1/products con withVariants,
# product_variants.meta_retailer_id + meta_mapping_locked + su índice,
# product_variants.contifico_id + contifico_sku + su índice,
# kommo_templates y /api/v1/meta/catalog/search (si Meta está configurado).
```

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
'), (SELECT max(id_producto) FROM products)); SELECT setval(pg_get_serial_sequence('product_variants','id_variante'), (SELECT max(id_variante) FROM product_variants)); SELECT setval(pg_get_serial_sequence('documents','id'), (SELECT max(id) FROM documents));"
```
