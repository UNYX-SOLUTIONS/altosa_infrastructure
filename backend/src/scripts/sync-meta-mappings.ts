/**
 * Sincroniza `product_variants.meta_retailer_id` desde el catálogo de Meta.
 *
 * Uso:
 *   pnpm sync:meta-mappings -- --file data/meta-catalog.json --dry-run
 *   pnpm sync:meta-mappings -- --file data/meta-catalog.json --apply
 *   pnpm sync:meta-mappings -- --apply --report data/meta-mapping-report.csv
 *   pnpm sync:meta-mappings -- --apply --match-by-name --include-inactive
 *   pnpm sync:meta-mappings -- --apply          (lee Graph API)
 *
 * Modo live (sin --file): requiere META_CATALOG_ID y META_ACCESS_TOKEN.
 * Opcional: META_API_VERSION (default v26.0). El token se envía solo en el
 * header Authorization y nunca se imprime.
 *
 * Estrategia de cruce, en orden:
 *   1. retailer_id == sku  -> ya funciona por el fallback de n8n.
 *   2. custom_label_0/1 == sku -> match exacto.
 *   3. [--match-by-name] nombre normalizado == nombre de producto con una sola
 *      variante activa (o una sola variante cuyo color aparezca en el nombre).
 *   4. el resto queda como ambiguo/sin match para revisión; nunca se adivina.
 *
 * Por defecto solo se usan cruces deterministas (SKU/custom labels). El cruce
 * por nombre es opt-in con --match-by-name y debe revisarse en el reporte.
 *
 * Por defecto solo se cargan variantes y productos activos. Usa
 * --include-inactive para pre-mapear también los inactivos (por ejemplo,
 * productos de Contifico pendientes de revisión).
 *
 * Solo escribe `meta_retailer_id`; no toca SKUs, precios ni otros campos.
 * Por defecto es dry-run: se requiere --apply para escribir.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';

interface MetaItem {
  retailerId: string;
  name: string;
  labels: string[];
  availability: string | null;
}

interface VariantRow {
  idVariante: number;
  sku: string | null;
  color: string | null;
  metaRetailerId: string | null;
  metaMappingLocked: boolean;
  productName: string;
}

interface VariantIndexes {
  bySku: Map<string, VariantRow[]>;
  byName: Map<string, VariantRow[]>;
  byRetailerId: Map<string, VariantRow[]>;
}

type OutcomeStatus =
  | 'proposed'
  | 'applied'
  | 'already_ok'
  | 'ambiguous'
  | 'unmatched'
  | 'conflict';

interface Outcome {
  item: MetaItem;
  status: OutcomeStatus;
  variant: VariantRow | null;
  strategy: string;
  detail: string;
  clearShared?: boolean;
}

interface ReportRow {
  status: string;
  sku: string;
  retailerId: string;
  metaName: string;
  productName: string;
  color: string;
  strategy: string;
  detail: string;
}

const META_FIELDS = 'retailer_id,name,custom_label_0,custom_label_1,availability';
const META_PAGE_LIMIT = 100;
const META_MAX_PAGES = 100;
const META_TIMEOUT_MS = 30_000;
const APPLY_BATCH_SIZE = 50;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeRetailerId(value: string | null): string {
  return (value ?? '').trim().toUpperCase();
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readOption(name: string): string | undefined {
  const args = process.argv.slice(2);
  const equalsArg = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equalsArg) {
    return equalsArg.slice(`--${name}=`.length);
  }
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    const next = args[index + 1];
    return next && !next.startsWith('--') ? next : undefined;
  }
  return undefined;
}

function assertKnownFlags(): void {
  const known = new Set([
    '--file',
    '--report',
    '--apply',
    '--force',
    '--match-by-name',
    '--include-inactive',
  ]);
  const args = process.argv.slice(2);
  const unknown = args.find(
    (arg) =>
      arg.startsWith('--') &&
      !known.has(arg) &&
      !arg.startsWith('--file=') &&
      !arg.startsWith('--report=')
  );
  if (unknown) {
    fail(
      `Opción desconocida: ${unknown}. Uso: pnpm sync:meta-mappings -- [--file <export.json>] [--report <salida.csv>] [--match-by-name] [--include-inactive] [--apply] [--force]`
    );
  }
}

function toMetaItem(value: unknown): MetaItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const retailerId = readString(value.retailer_id) ?? readString(value.retailerId);
  if (!retailerId) {
    return null;
  }
  const labels = [
    value.custom_label_0,
    value.custom_label_1,
    value.customLabel0,
    value.customLabel1,
  ]
    .map(readString)
    .filter((label): label is string => Boolean(label));
  return {
    retailerId,
    name: readString(value.name) ?? '',
    labels,
    availability: readString(value.availability),
  };
}

function parseMetaExport(content: string): MetaItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    fail(`JSON inválido: ${error instanceof Error ? error.message : String(error)}`);
  }

  const array = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : isRecord(parsed) && Array.isArray(parsed.products)
        ? parsed.products
        : isRecord(parsed) && Array.isArray(parsed.items)
          ? parsed.items
          : null;

  if (!array) {
    fail('El JSON debe ser un arreglo o un objeto con data[] / products[] / items[].');
  }

  const items = array
    .map(toMetaItem)
    .filter((item): item is MetaItem => item !== null);

  if (items.length === 0) {
    fail('El export no contiene items con retailer_id.');
  }
  return items;
}

function validateGraphUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Meta devolvió una URL de paginación inválida.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw new Error(`Meta devolvió una URL de paginación inesperada: ${url.origin}`);
  }
  return url.toString();
}

async function fetchCatalogFromMeta(): Promise<MetaItem[]> {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const catalogId = process.env.META_CATALOG_ID?.trim();
  if (!token || !catalogId) {
    fail(
      'Faltan META_ACCESS_TOKEN y/o META_CATALOG_ID. Define ambos o usa --file <export.json>.'
    );
  }

  const version = process.env.META_API_VERSION?.trim() || 'v26.0';
  let nextUrl: string | null = `https://graph.facebook.com/${version}/${encodeURIComponent(
    catalogId
  )}/products?fields=${encodeURIComponent(META_FIELDS)}&limit=${META_PAGE_LIMIT}`;
  const items: MetaItem[] = [];
  let pages = 0;

  while (nextUrl) {
    if (++pages > META_MAX_PAGES) {
      throw new Error(`Se superó el límite de ${META_MAX_PAGES} páginas del catálogo de Meta.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(validateGraphUrl(nextUrl), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Tiempo de espera agotado consultando el catálogo de Meta.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`Meta Graph API respondió ${response.status}: ${body}`);
    }

    const body = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error('Respuesta inesperada de Meta: falta data[].');
    }
    for (const raw of body.data) {
      const item = toMetaItem(raw);
      if (item) {
        items.push(item);
      }
    }

    const paging = isRecord(body.paging) ? body.paging : null;
    nextUrl = paging && typeof paging.next === 'string' ? paging.next : null;
  }

  return items;
}

async function loadVariants(includeInactive: boolean): Promise<VariantRow[]> {
  const rows = await getPrisma().productoVariante.findMany({
    where: includeInactive
      ? {}
      : { isActive: true, producto: { isActive: true } },
    select: {
      idVariante: true,
      sku: true,
      color: true,
      metaRetailerId: true,
      metaMappingLocked: true,
      producto: { select: { producto: true } },
    },
    orderBy: { idVariante: 'asc' },
  });

  return rows.map((row) => ({
    idVariante: row.idVariante,
    sku: row.sku,
    color: row.color,
    metaRetailerId: row.metaRetailerId,
    metaMappingLocked: row.metaMappingLocked,
    productName: row.producto.producto,
  }));
}

function pushIndexed(
  index: Map<string, VariantRow[]>,
  key: string,
  variant: VariantRow
): void {
  if (!index.has(key)) {
    index.set(key, []);
  }
  index.get(key)!.push(variant);
}

function buildIndexes(variants: VariantRow[]): VariantIndexes {
  const bySku = new Map<string, VariantRow[]>();
  const byName = new Map<string, VariantRow[]>();
  const byRetailerId = new Map<string, VariantRow[]>();
  for (const variant of variants) {
    if (!variant.metaMappingLocked) {
      if (variant.sku) {
        pushIndexed(bySku, normalizeSku(variant.sku), variant);
      }
      if (variant.productName) {
        pushIndexed(byName, normalizeText(variant.productName), variant);
      }
    }
    if (variant.metaRetailerId) {
      pushIndexed(byRetailerId, normalizeRetailerId(variant.metaRetailerId), variant);
    }
  }
  return { bySku, byName, byRetailerId };
}

function matchItem(
  item: MetaItem,
  indexes: VariantIndexes,
  allowNameMatch: boolean
): Outcome {
  const base: Outcome = {
    item,
    status: 'unmatched',
    variant: null,
    strategy: '',
    detail: '',
  };

  // Si el retailer_id ya está mapeado en Altosa, no se vuelve a proponer: el
  // cron determinista debe ser estable aunque el mapeo se haya creado por
  // nombre o por backfill.
  const alreadyMapped = indexes.byRetailerId.get(normalizeRetailerId(item.retailerId)) ?? [];
  if (alreadyMapped.length === 1) {
    return {
      ...base,
      status: 'already_ok',
      variant: alreadyMapped[0]!,
      strategy: 'existing',
      detail: alreadyMapped[0]!.metaMappingLocked
        ? 'retailer_id ya mapeado en Altosa (mapeo manual bloqueado)'
        : 'retailer_id ya mapeado en Altosa',
    };
  }
  if (alreadyMapped.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      variant: alreadyMapped[0]!,
      strategy: 'existing',
      detail: `hay ${alreadyMapped.length} variantes con el mismo meta_retailer_id`,
    };
  }

  const direct = indexes.bySku.get(normalizeSku(item.retailerId)) ?? [];
  if (direct.length === 1) {
    const variant = direct[0]!;
    if (
      !variant.metaRetailerId ||
      normalizeRetailerId(variant.metaRetailerId) === normalizeRetailerId(item.retailerId)
    ) {
      return {
        ...base,
        status: 'already_ok',
        variant,
        strategy: 'sku',
        detail: 'retailer_id coincide con el SKU; el fallback de n8n ya funciona',
      };
    }
    return {
      ...base,
      status: 'conflict',
      variant,
      strategy: 'sku',
      detail: `el SKU ya está mapeado a ${variant.metaRetailerId}`,
    };
  }
  if (direct.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      variant: direct[0]!,
      strategy: 'sku',
      detail: `hay ${direct.length} variantes con el mismo SKU`,
    };
  }

  const labelMatches = new Set<VariantRow>();
  for (const label of item.labels) {
    for (const variant of indexes.bySku.get(normalizeSku(label)) ?? []) {
      labelMatches.add(variant);
    }
  }
  if (labelMatches.size === 1) {
    return {
      ...base,
      status: 'proposed',
      variant: Array.from(labelMatches)[0]!,
      strategy: 'label',
      detail: 'custom_label coincide con el SKU',
    };
  }
  if (labelMatches.size > 1) {
    return {
      ...base,
      status: 'ambiguous',
      variant: Array.from(labelMatches)[0]!,
      strategy: 'label',
      detail: 'varios custom_labels apuntan a SKUs distintos',
    };
  }

  if (!allowNameMatch) {
    return base;
  }

  const nameMatches = indexes.byName.get(normalizeText(item.name)) ?? [];
  if (nameMatches.length === 1) {
    return {
      ...base,
      status: 'proposed',
      variant: nameMatches[0]!,
      strategy: 'name',
      detail: 'nombre de producto único',
    };
  }
  if (nameMatches.length > 1) {
    const normalizedName = normalizeText(item.name);
    const colorMatches = nameMatches.filter(
      (variant) => variant.color && normalizedName.includes(normalizeText(variant.color))
    );
    if (colorMatches.length === 1) {
      return {
        ...base,
        status: 'proposed',
        variant: colorMatches[0]!,
        strategy: 'name+color',
        detail: 'nombre y color coinciden con una sola variante',
      };
    }
    return {
      ...base,
      status: 'ambiguous',
      variant: nameMatches[0]!,
      strategy: 'name',
      detail: `el nombre coincide con ${nameMatches.length} variantes activas`,
    };
  }

  return base;
}

function finalizeOutcomes(outcomes: Outcome[], variants: VariantRow[], force: boolean): void {
  const proposalsByVariant = new Map<number, Outcome[]>();
  const proposalsByRetailer = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    if (outcome.status !== 'proposed' || !outcome.variant) {
      continue;
    }
    const variantId = outcome.variant.idVariante;
    if (!proposalsByVariant.has(variantId)) {
      proposalsByVariant.set(variantId, []);
    }
    proposalsByVariant.get(variantId)!.push(outcome);

    const retailerKey = normalizeRetailerId(outcome.item.retailerId);
    if (!proposalsByRetailer.has(retailerKey)) {
      proposalsByRetailer.set(retailerKey, []);
    }
    proposalsByRetailer.get(retailerKey)!.push(outcome);
  }

  for (const group of proposalsByVariant.values()) {
    if (group.length > 1) {
      for (const outcome of group) {
        outcome.status = 'conflict';
        outcome.detail = 'varios items de Meta apuntan a la misma variante';
      }
    }
  }
  for (const group of proposalsByRetailer.values()) {
    if (group.length > 1) {
      for (const outcome of group) {
        outcome.status = 'conflict';
        outcome.detail = 'varios SKUs apuntan al mismo retailer_id';
      }
    }
  }

  const ownersByRetailer = new Map<string, Set<string>>();
  for (const variant of variants) {
    if (!variant.metaRetailerId || !variant.sku) {
      continue;
    }
    const key = normalizeRetailerId(variant.metaRetailerId);
    if (!ownersByRetailer.has(key)) {
      ownersByRetailer.set(key, new Set());
    }
    ownersByRetailer.get(key)!.add(normalizeSku(variant.sku));
  }

  for (const outcome of outcomes) {
    if (outcome.status !== 'proposed' || !outcome.variant) {
      continue;
    }
    const existing = outcome.variant.metaRetailerId;
    if (existing && normalizeRetailerId(existing) !== normalizeRetailerId(outcome.item.retailerId)) {
      if (!force) {
        outcome.status = 'conflict';
        outcome.detail = `la variante ya está mapeada a ${existing}`;
        continue;
      }
      outcome.detail = `${outcome.detail}; reasignado con --force`;
    }

    const ownerSkus = ownersByRetailer.get(normalizeRetailerId(outcome.item.retailerId));
    const ownSku = normalizeSku(outcome.variant.sku ?? '');
    if (ownerSkus && Array.from(ownerSkus).some((sku) => sku !== ownSku)) {
      if (!force) {
        outcome.status = 'conflict';
        outcome.detail = `el retailer_id ya pertenece a otro SKU (${Array.from(ownerSkus).join(', ')})`;
        continue;
      }
      outcome.clearShared = true;
      outcome.detail = `${outcome.detail}; se libera el retailer_id de otro SKU (--force)`;
    }
  }
}

async function applyProposals(proposals: Outcome[]): Promise<void> {
  const prisma = getPrisma();
  for (let index = 0; index < proposals.length; index += APPLY_BATCH_SIZE) {
    const batch = proposals.slice(index, index + APPLY_BATCH_SIZE);
    await prisma.$transaction(
      batch.flatMap((outcome) => [
        ...(outcome.clearShared
          ? [
              prisma.productoVariante.updateMany({
                where: {
                  metaRetailerId: {
                    equals: outcome.item.retailerId,
                    mode: 'insensitive',
                  },
                  metaMappingLocked: false,
                  NOT: { idVariante: outcome.variant!.idVariante },
                },
                data: { metaRetailerId: null },
              }),
            ]
          : []),
        prisma.productoVariante.update({
          where: { idVariante: outcome.variant!.idVariante },
          data: { metaRetailerId: outcome.item.retailerId },
        }),
      ])
    );
  }
  for (const outcome of proposals) {
    outcome.status = 'applied';
  }
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(outcomes: Outcome[]): string {
  const header =
    'status,sku,meta_retailer_id,meta_name,product_name,color,strategy,detail';
  const lines = outcomes.map((outcome) =>
    [
      outcome.status,
      outcome.variant?.sku ?? '',
      outcome.item.retailerId,
      outcome.item.name,
      outcome.variant?.productName ?? '',
      outcome.variant?.color ?? '',
      outcome.strategy,
      outcome.detail,
    ]
      .map((value) => csvEscape(String(value)))
      .join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

async function writeReport(reportPath: string, outcomes: Outcome[]): Promise<void> {
  const fullPath = resolve(process.cwd(), reportPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, toCsv(outcomes), 'utf8');
  console.log(`Reporte CSV: ${fullPath}`);
}

async function main(): Promise<void> {
  assertKnownFlags();

  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const matchByName = process.argv.includes('--match-by-name');
  const includeInactive = process.argv.includes('--include-inactive');
  const fileArg = readOption('file');
  const reportArg = readOption('report');
  if (process.argv.includes('--file') && !fileArg) {
    fail('--file requiere una ruta al export JSON.');
  }
  if (process.argv.includes('--report') && !reportArg) {
    fail('--report requiere una ruta de salida CSV.');
  }

  const items = fileArg
    ? parseMetaExport(await readFile(resolve(process.cwd(), fileArg), 'utf8'))
    : await fetchCatalogFromMeta();

  const variants = await loadVariants(includeInactive);
  console.log(
    `Catálogo Meta: ${items.length} items (${fileArg ? `archivo ${fileArg}` : 'Graph API'})`
  );
  console.log(`Variantes activas en Altosa: ${variants.length}`);

  const indexes = buildIndexes(variants);
  const outcomes = items.map((item) => matchItem(item, indexes, matchByName));
  finalizeOutcomes(outcomes, variants, force);

  const proposals = outcomes.filter((outcome) => outcome.status === 'proposed');
  if (apply && proposals.length > 0) {
    await applyProposals(proposals);
  }

  const counts: Record<OutcomeStatus, number> = {
    proposed: 0,
    applied: 0,
    already_ok: 0,
    ambiguous: 0,
    unmatched: 0,
    conflict: 0,
  };
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
  }

  console.log(
    `Resultado: ${counts.applied} aplicadas, ${counts.proposed} propuestas, ` +
      `${counts.already_ok} ya OK, ${counts.ambiguous} ambiguas, ` +
      `${counts.unmatched} sin match, ${counts.conflict} conflictos.`
  );

  const pending = outcomes.filter(
    (outcome) =>
      outcome.status === 'ambiguous' ||
      outcome.status === 'unmatched' ||
      outcome.status === 'conflict'
  );
  for (const outcome of pending.slice(0, 20)) {
    console.log(
      `  - ${outcome.status}: ${outcome.item.name || '(sin nombre)'} [${outcome.item.retailerId}] ${outcome.detail}`
    );
  }
  if (pending.length > 20) {
    console.log(`  ... y ${pending.length - 20} más; usa --report para el detalle completo.`);
  }

  if (reportArg) {
    await writeReport(reportArg, outcomes);
  }
  if (!apply) {
    console.log('Dry-run: no se escribió nada. Usa --apply para aplicar las propuestas.');
  }
  if (!matchByName && counts.unmatched > 0) {
    console.log(
      'Hay items sin match. Puedes probar --match-by-name y revisar el reporte antes de aplicar.'
    );
  }

  if (counts.proposed + counts.applied + counts.already_ok === 0) {
    console.error(
      'Ningún cruce seguro. Revisa los nombres/SKUs o genera el mapeo manual y usa backfill:meta-retailer-ids.'
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
