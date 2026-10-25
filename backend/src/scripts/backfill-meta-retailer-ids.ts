/**
 * Backfill de `product_variants.meta_retailer_id` (Retailer ID del catálogo de Meta).
 *
 * Uso:
 *   pnpm backfill:meta-retailer-ids -- <archivo.csv|json> [--dry-run] [--force]
 *
 * Formatos soportados:
 * - CSV con encabezado `sku,retailer_id` (también acepta `retailerId`).
 * - JSON: arreglo de `{ "sku": "...", "retailer_id": "..." }` (o `retailerId`)
 *   o un mapa `{ "PC155-GO": "WC-240482" }`.
 *
 * Es idempotente: solo escribe las variantes cuyo valor actual difiere del
 * mapeo. `--dry-run` reporta sin escribir. `--force` permite reasignar un
 * Retailer ID que ya pertenece a otro SKU. Las variantes con
 * `meta_mapping_locked = true` se omiten por defecto; con `--force` se
 * actualizan y quedan bloqueadas. No modifica SKUs ni otros campos.
 * Los Retailer IDs se obtienen del catálogo de Meta:
 *   GET https://graph.facebook.com/v26.0/<catalog_id>/products?fields=retailer_id,name
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';

interface MappingRow {
  sku: string;
  retailerId: string;
}

interface BackfillStats {
  updated: number;
  unchanged: number;
  notFound: number;
  conflicts: number;
  cleared: number;
  locked: number;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeRetailerId(value: string | null): string {
  return (value ?? '').trim().toUpperCase();
}

function describeDatabase(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return 'DATABASE_URL no definida';
  }
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, '') || '(sin nombre)';
    return `${url.hostname}:${url.port || '5432'}/${database}`;
  } catch {
    return 'DATABASE_URL inválida';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRetailerId(item: Record<string, unknown>): string | null {
  const value = item.retailer_id ?? item.retailerId;
  return typeof value === 'string' ? value.trim() : null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^"(.*)"$/, '$1').trim();
}

function parseCsv(content: string): MappingRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    fail('El CSV está vacío.');
  }

  const firstCells = lines[0]!.split(',').map((cell) => stripQuotes(cell).toLowerCase());
  const hasHeader =
    firstCells[0] === 'sku' &&
    (firstCells[1] === 'retailer_id' || firstCells[1] === 'retailerid');

  return lines.slice(hasHeader ? 1 : 0).map((line, index) => {
    const lineNumber = index + (hasHeader ? 2 : 1);
    const cells = line.split(',');
    if (cells.length < 2) {
      fail(`CSV inválido en la línea ${lineNumber}: se esperaba sku,retailer_id.`);
    }
    const sku = stripQuotes(cells[0]!);
    const retailerId = stripQuotes(cells[1]!);
    if (!sku || !retailerId) {
      fail(`CSV inválido en la línea ${lineNumber}: sku y retailer_id son obligatorios.`);
    }
    return { sku, retailerId };
  });
}

function parseJson(content: string): MappingRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    fail(`JSON inválido: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => {
      if (!isRecord(item)) {
        fail(`JSON inválido en el elemento ${index + 1}: se esperaba un objeto.`);
      }
      const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
      const retailerId = readRetailerId(item);
      if (!sku || !retailerId) {
        fail(`JSON inválido en el elemento ${index + 1}: sku y retailer_id son obligatorios.`);
      }
      return { sku, retailerId };
    });
  }

  if (isRecord(parsed)) {
    return Object.entries(parsed).map(([sku, value]) => {
      if (typeof value !== 'string') {
        fail(`JSON inválido para el SKU "${sku}": el Retailer ID debe ser string.`);
      }
      const normalizedSku = sku.trim();
      const retailerId = value.trim();
      if (!normalizedSku || !retailerId) {
        fail(`JSON inválido: el SKU "${sku}" tiene un Retailer ID vacío.`);
      }
      return { sku: normalizedSku, retailerId };
    });
  }

  fail('El JSON debe ser un arreglo de mapeos o un objeto { sku: retailer_id }.');
}

function dedupeRows(rows: MappingRow[]): MappingRow[] {
  const bySku = new Map<string, string>();
  for (const row of rows) {
    const existing = bySku.get(row.sku);
    if (existing !== undefined && existing !== row.retailerId) {
      console.warn(
        `[!] SKU duplicado en el archivo: "${row.sku}" (${existing} -> ${row.retailerId}); se usa el último.`
      );
    }
    bySku.set(row.sku, row.retailerId);
  }
  return Array.from(bySku, ([sku, retailerId]) => ({ sku, retailerId }));
}

function warnSharedRetailerIds(rows: MappingRow[]): void {
  const byRetailer = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = normalizeRetailerId(row.retailerId);
    if (!byRetailer.has(key)) {
      byRetailer.set(key, new Set());
    }
    byRetailer.get(key)!.add(row.sku);
  }
  for (const [retailerId, skus] of byRetailer) {
    if (skus.size > 1) {
      console.warn(
        `[!] El Retailer ID "${retailerId}" está asignado a varios SKUs: ${Array.from(skus).join(', ')}`
      );
    }
  }
}

async function applyMappings(
  rows: MappingRow[],
  dryRun: boolean,
  force: boolean
): Promise<BackfillStats> {
  const prisma = getPrisma();
  const stats: BackfillStats = {
    updated: 0,
    unchanged: 0,
    notFound: 0,
    conflicts: 0,
    cleared: 0,
    locked: 0,
  };
  const missing: string[] = [];
  const lockedSkus = new Set<string>();

  const existingMappings = await prisma.productoVariante.findMany({
    where: { metaRetailerId: { not: null } },
    select: { sku: true, metaRetailerId: true },
  });
  const ownersByRetailer = new Map<string, Set<string>>();
  for (const mapping of existingMappings) {
    if (!mapping.metaRetailerId || !mapping.sku) {
      continue;
    }
    const key = normalizeRetailerId(mapping.metaRetailerId);
    if (!ownersByRetailer.has(key)) {
      ownersByRetailer.set(key, new Set());
    }
    ownersByRetailer.get(key)!.add(normalizeSku(mapping.sku));
  }

  for (const row of rows) {
    const ownerSkus = ownersByRetailer.get(normalizeRetailerId(row.retailerId));
    const ownedByAnotherSku = ownerSkus
      ? Array.from(ownerSkus).some((sku) => sku !== normalizeSku(row.sku))
      : false;

    if (ownedByAnotherSku && !force) {
      stats.conflicts += 1;
      console.warn(
        `[!] El Retailer ID "${row.retailerId}" ya está asignado a otro SKU (${Array.from(
          ownerSkus ?? []
        ).join(', ')}); se omite "${row.sku}". Usa --force para reasignarlo.`
      );
      continue;
    }
    if (ownedByAnotherSku && force) {
      console.warn(
        `[!] Reasignando el Retailer ID "${row.retailerId}" de ${Array.from(ownerSkus ?? []).join(
          ', '
        )} a "${row.sku}" (--force).`
      );
      if (!dryRun) {
        const cleared = await prisma.productoVariante.updateMany({
          where: {
            metaRetailerId: { equals: row.retailerId, mode: 'insensitive' },
            NOT: { sku: row.sku },
          },
          data: { metaRetailerId: null },
        });
        stats.cleared += cleared.count;
      }
    }

    const variants = await prisma.productoVariante.findMany({
      where: { sku: row.sku },
      select: {
        idVariante: true,
        metaRetailerId: true,
        metaMappingLocked: true,
      },
    });

    if (variants.length === 0) {
      stats.notFound += 1;
      missing.push(row.sku);
      continue;
    }
    if (variants.length > 1) {
      console.warn(
        `[!] El SKU "${row.sku}" tiene ${variants.length} variantes; se actualizan todas.`
      );
    }

    for (const variant of variants) {
      if (variant.metaMappingLocked && !force) {
        stats.locked += 1;
        lockedSkus.add(row.sku);
        continue;
      }
      const isSame =
        normalizeRetailerId(variant.metaRetailerId) === normalizeRetailerId(row.retailerId);
      if (isSame) {
        if (force && !variant.metaMappingLocked) {
          if (!dryRun) {
            await prisma.productoVariante.update({
              where: { idVariante: variant.idVariante },
              data: { metaMappingLocked: true },
            });
          }
          stats.updated += 1;
          continue;
        }
        stats.unchanged += 1;
        continue;
      }
      if (!dryRun) {
        await prisma.productoVariante.update({
          where: { idVariante: variant.idVariante },
          data: { metaRetailerId: row.retailerId, metaMappingLocked: true },
        });
      }
      stats.updated += 1;
    }
  }

  if (lockedSkus.size > 0) {
    const preview = Array.from(lockedSkus).slice(0, 25).join(', ');
    const suffix = lockedSkus.size > 25 ? ` … y ${lockedSkus.size - 25} más` : '';
    console.warn(
      `[!] Variantes con mapeo manual bloqueado omitidas: ${preview}${suffix}. Usa --force para sobrescribirlas.`
    );
  }

  if (missing.length > 0) {
    const preview = missing.slice(0, 25).join(', ');
    const suffix = missing.length > 25 ? ` … y ${missing.length - 25} más` : '';
    console.warn(`[!] SKUs no encontrados en product_variants: ${preview}${suffix}`);
  }

  return stats;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowedFlags = new Set(['--dry-run', '--force']);
  const unknownFlag = args.find((arg) => arg.startsWith('--') && !allowedFlags.has(arg));
  if (unknownFlag) {
    fail(
      `Opción desconocida: ${unknownFlag}. Uso: pnpm backfill:meta-retailer-ids -- <archivo.csv|json> [--dry-run] [--force]`
    );
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const fileArg = args.find((arg) => !arg.startsWith('--'));
  if (!fileArg) {
    fail('Uso: pnpm backfill:meta-retailer-ids -- <archivo.csv|json> [--dry-run] [--force]');
  }

  const filePath = resolve(process.cwd(), fileArg);
  const content = await readFile(filePath, 'utf8');
  const trimmed = content.trim();
  const isJson = filePath.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{');
  const rows = dedupeRows(isJson ? parseJson(content) : parseCsv(content));

  if (rows.length === 0) {
    fail('El archivo no contiene mapeos sku,retailer_id.');
  }

  warnSharedRetailerIds(rows);
  console.log(`BD destino: ${describeDatabase()}`);

  const stats = await applyMappings(rows, dryRun, force);
  const mode = dryRun ? ' (dry-run, sin escribir)' : '';
  console.log(
    `Backfill${mode} completado: ${rows.length} mapeos, ` +
      `${stats.updated} variantes ${dryRun ? 'a actualizar' : 'actualizadas'}, ` +
      `${stats.unchanged} sin cambios, ${stats.locked} bloqueadas omitidas, ` +
      `${stats.notFound} SKUs no encontrados, ` +
      `${stats.conflicts} conflictos, ${stats.cleared} mapeos liberados.`
  );

  if (stats.updated + stats.unchanged + stats.locked === 0) {
    console.error('Ningún mapeo coincidió con variantes existentes; revisa los SKUs del archivo.');
    process.exitCode = 1;
  }
  if (stats.conflicts > 0) {
    console.error(
      'Hay Retailer IDs ya asignados a otros SKUs. Revisa el archivo o usa --force para reasignarlos.'
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
