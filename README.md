# ALTOSA Infrastructure

Infraestructura Docker inicial para ALTOSA: PostgreSQL 16 + pgvector y pgAdmin.

## Seguridad
- PostgreSQL no publica el puerto 5432 al host.
- pgAdmin queda inicialmente en `127.0.0.1:5050` para validación local/túnel SSH.
- `.env` no se versiona en Git.
- Los volúmenes Docker no se almacenan en GitHub.

## Instalación
```bash
cd /docker
git clone <URL_REPOSITORIO> altosa-infrastructure
cd altosa-infrastructure
chmod +x install.sh update.sh backup.sh scripts/*.sh
./install.sh
```

## Comandos
```bash
./scripts/healthcheck.sh
./backup.sh
./scripts/restore-postgres.sh backups/archivo.dump
./update.sh
```

## Conexión interna PostgreSQL
- Host: `postgres`
- Puerto: `5432`
- Base/usuario: definidos en `.env`

## Próxima etapa
Integrar pgAdmin con el Traefik existente mediante HTTPS y conectar n8n a `altosa_backend`. No se incluyen secretos ni se modifica aún el despliegue n8n/Traefik de Hostinger.
