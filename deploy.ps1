# ============================================================================
# Altosa Infrastructure - Sube el proyecto al VPS y despliega/actualiza
#
# Uso (PowerShell 7, desde la raíz de altosa_infrastructure):
#   .\deploy.ps1 -VpsHost 203.0.113.10
#   .\deploy.ps1 -VpsHost 203.0.113.10 -PublicDomain api.altosamobiliario.com
#   .\deploy.ps1 -VpsHost 203.0.113.10 -NoBackup
#   .\deploy.ps1 -VpsHost 203.0.113.10 -ApiOnly    # solo API; no recrea pgAdmin/PostgreSQL
#   .\deploy.ps1 -VpsHost 203.0.113.10 -SkipUpload
#
# Requisitos locales: OpenSSH (ssh, scp) y tar.
# Requisitos remotos: Docker + Traefik.
# El archivo .env remoto NO se sube: se conserva y se completa en el VPS.
# ============================================================================

param(
  [Parameter(Mandatory = $true)][string]$VpsHost,
  [string]$VpsUser = 'root',
  [int]$SshPort = 22,
  [string]$RemoteDir = '/docker/altosa_infrastructure',
  [string]$PublicDomain = '',
  [switch]$SkipUpload,
  [switch]$NoBackup,
  [switch]$ApiOnly
)

$ErrorActionPreference = 'Stop'

foreach ($cmd in 'ssh', 'scp', 'tar') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "No se encontro '$cmd' en PATH. Instala el cliente OpenSSH (Configuracion > Aplicaciones > Caracteristicas opcionales > Cliente OpenSSH)."
  }
}

$repoRoot = $PSScriptRoot
$target = "$VpsUser@$VpsHost"
$sshArgs = @('-p', "$SshPort", '-o', 'StrictHostKeyChecking=accept-new')
$scpArgs = @('-P', "$SshPort", '-o', 'StrictHostKeyChecking=accept-new')

if (-not $SkipUpload) {
  $archive = Join-Path $env:TEMP 'altosa-infrastructure.tar.gz'
  if (Test-Path $archive) { Remove-Item $archive -Force }

  Write-Host "==> Empaquetando Altosa (sin node_modules, dist, .git, backups ni .env)..." -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=backups `
      --exclude=.env --exclude='.env.*' --exclude='*.log' -czf $archive .
    if ($LASTEXITCODE -ne 0) { throw 'tar fallo al empaquetar Altosa.' }
  } finally {
    Pop-Location
  }

  $sizeMb = [math]::Round((Get-Item $archive).Length / 1MB, 1)
  Write-Host "==> Paquete listo ($sizeMb MB). Subiendo a ${target}..." -ForegroundColor Cyan
  & scp @scpArgs $archive "${target}:/tmp/altosa-infrastructure.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'scp fallo al subir el paquete.' }

  Write-Host "==> Extrayendo en $RemoteDir ..." -ForegroundColor Cyan
  & ssh @sshArgs $target "mkdir -p '$RemoteDir' && tar -xzf /tmp/altosa-infrastructure.tar.gz -C '$RemoteDir' && rm -f /tmp/altosa-infrastructure.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'La extraccion remota fallo.' }
}

$installArg = if ($PublicDomain) { " '$PublicDomain'" } else { '' }
$backupFlag = if ($NoBackup) { ' --no-backup' } else { '' }
$apiOnlyFlag = if ($ApiOnly) { ' --api-only' } else { '' }
$remoteCmd = "cd '$RemoteDir' && " +
  "for f in install.sh update.sh backup.sh uninstall.sh scripts/*.sh; do sed -i 's/\r`$//' `"`$f`"; chmod +x `"`$f`"; done; " +
  "if [ -f .env ] && grep -q '^ALTOSA_API_KEY=.' .env && grep -q '^ALTOSA_PUBLIC_URL_BASE=.' .env && grep -q '^ALTOSA_PUBLIC_DOMAIN=.' .env; then " +
  "if [ `$(id -u) -eq 0 ]; then bash update.sh$backupFlag$apiOnlyFlag; else sudo bash update.sh$backupFlag$apiOnlyFlag; fi; " +
  "else " +
  "if [ `$(id -u) -eq 0 ]; then bash install.sh$installArg; else sudo bash install.sh$installArg; fi; " +
  "fi"

Write-Host "==> Ejecutando despliegue de Altosa en el VPS (SSH)..." -ForegroundColor Cyan
& ssh @sshArgs $target $remoteCmd
if ($LASTEXITCODE -ne 0) { throw 'El despliegue remoto de Altosa fallo. Revisa la salida de arriba.' }

$apiKey = (& ssh @sshArgs $target "grep -m1 '^ALTOSA_API_KEY=' '$RemoteDir/.env' | cut -d= -f2-").Trim()
$apiUrl = (& ssh @sshArgs $target "grep -m1 '^ALTOSA_PUBLIC_URL_BASE=' '$RemoteDir/.env' | cut -d= -f2-").Trim()

Write-Host ""
Write-Host "Altosa desplegada." -ForegroundColor Green
if ($apiUrl) { Write-Host "ALTOSA_API_URL=$apiUrl" -ForegroundColor Green }
if ($apiKey) { Write-Host "ALTOSA_API_KEY=$apiKey" -ForegroundColor Yellow }
Write-Host ""
Write-Host "Copia esos dos valores al .env.production del ERP y reinicia su backend." -ForegroundColor Yellow
Write-Host "No compartas esta salida: contiene la API key." -ForegroundColor Yellow
Write-Host "
Plantillas Kommo: agrega KOMMO_API_URL y KOMMO_API_KEY al .env de Altosa y ejecuta update.sh.
Meta: agrega META_ACCESS_TOKEN (y META_CATALOG_ID si aplica) al .env de Altosa para el selector y el sync de mapeo." -ForegroundColor Cyan
