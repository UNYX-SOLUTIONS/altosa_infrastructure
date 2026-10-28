/**
 * Genera un CSV de sugerencias Meta -> variante Altosa.
 *
 * No escribe en la base de datos. Solo sugiere candidatos para revisión.
 *
 * Uso:
 *   pnpm suggest:meta-mappings -- --report data/meta-suggestions.csv
 *   pnpm suggest:meta-mappings -- --report data/meta-suggestions.csv --min-score 0.55 --limit 3
 *
 * Requiere META_CATALOG_ID y META_ACCESS_TOKEN. El token se envía solo en el
 * header Authorization.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';

const META_FIELDS = 'retailer_id,name,custom_label_0,custom_label_1,availability';
const META_PAGE_LIMIT = 100;
const META_MAX_PAGES = 100;
const META_TIMEOUT_MS = 30_000;

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
  isActive: boolean;
  metaRetailerId: string | null;
  productId: number;
  productName: string;
  productActive: boolean;
}

interface Candidate {
  variant: VariantRow;
  score: number;
  reason: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readOption(name: string): string | undefined {
  const args = process.argv.slice(2);
  const equalsArg = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equalsArg) {
    return equalsArg.slice(`--${name}=`.length);
  }
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    return args[index + 1];
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toMetaItem(value: unknown): MetaItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const retailerId = readString(value.retailer_id) ?? readString(value.retailerId);
  if (!retailerId) {
    return null;
  }
  const labels = [value.custom_label_0, value.custom_label_1]
    .map(readString)
    .filter((label): label is string => Boolean(label));
  return {
    retailerId,
    name: readString(value.name) ?? '',
    labels,
    availability: readString(value.availability),
  };
}

function validateGraphUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Meta devolvió una URL de paginación inválida.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw new Error('Meta devolvió una URL de paginación inesperada.');
  }
  url.searchParams.delete('access_token');
  return url.toString();
}

async function fetchMetaCatalog(): Promise<MetaItem[]> {
  const catalogId = process.env.META_CATALOG_ID?.trim();
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const version = process.env.META_API_VERSION?.trim() || 'v26.0';
  if (!catalogId || !token) {
    fail('Faltan META_CATALOG_ID y/o META_ACCESS_TOKEN.');
  }

  let nextUrl: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(catalogId)}/products` +
    `?fields=${encodeURIComponent(META_FIELDS)}&limit=${META_PAGE_LIMIT}`;
  const items: MetaItem[] = [];
  let pages = 0;

  while (nextUrl) {
    if (++pages > META_MAX_PAGES) {
      fail(`Se superó el límite de ${META_MAX_PAGES} páginas de Meta.`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(validateGraphUrl(nextUrl), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      fail(
        error instanceof Error && error.name === 'AbortError'
          ? 'Timeout consultando Meta.'
          : 'No se pudo conectar con Meta.'
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      fail(`Meta respondió HTTP ${response.status} al consultar el catálogo.`);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !Array.isArray(body.data)) {
      fail('Meta devolvió una respuesta inesperada.');
    }
    for (const raw of body.data) {
      const item = toMetaItem(raw);
      if (item) {
        items.push(item);
      }
    }
    nextUrl =
      isRecord(body.paging) && typeof body.paging.next === 'string'
        ? body.paging.next
        : null;
  }

  return items;
}

async function loadVariants(): Promise<VariantRow[]> {
  const rows = await getPrisma().productoVariante.findMany({
    select: {
      idVariante: true,
      sku: true,
      color: true,
      isActive: true,
      metaRetailerId: true,
      producto: { select: { idProducto: true, producto: true, isActive: true } },
    },
    orderBy: { idVariante: 'asc' },
  });

  return rows.map((row) => ({
    idVariante: row.idVariante,
    sku: row.sku,
    color: row.color,
    isActive: row.isActive,
    metaRetailerId: row.metaRetailerId,
    productId: row.producto.idProducto,
    productName: row.producto.producto,
    productActive: row.producto.isActive,
  }));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function scoreCandidate(item: MetaItem, variant: VariantRow): Candidate | null {
  const retailer = item.retailerId.trim().toUpperCase();
  const sku = (variant.sku ?? '').trim().toUpperCase();
  const labels = item.labels.map((label) => label.trim().toUpperCase());

  if (sku && retailer === sku) {
    return { variant, score: 1, reason: 'retailer_id == SKU' };
  }
  if (sku && labels.includes(sku)) {
    return { variant, score: 0.98, reason: 'custom_label == SKU' };
  }

  const metaName = normalizeText(item.name);
  const productName = normalizeText(variant.productName);
  const color = normalizeText(variant.color ?? '');
  if (!metaName || !productName) {
    return null;
  }

  const metaTokens = new Set(tokens(item.name));
  const productTokens = new Set(tokens(variant.productName));
  const colorTokens = new Set(tokens(variant.color ?? ''));
  const overlap = jaccard(metaTokens, productTokens);
  let score = overlap * 0.8;
  let reason = `tokens producto=${overlap.toFixed(2)}`;

  if (productName.length >= 6 && metaName.includes(productName)) {
    score = Math.max(score, 0.85);
    reason = 'nombre de producto contenido en nombre Meta';
  }
  if (color) {
    if (metaName.includes(color)) {
      score += 0.1;
      reason += ' + color';
    } else if (colorTokens.size > 0 && ![...colorTokens].some((token) => metaTokens.has(token))) {
      score -= 0.05;
      reason += ' - color distinto';
    }
  }

  if (score < 0.35) {
    return null;
  }
  return { variant, score: Math.min(score, 0.94), reason };
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const reportPath = readOption('report');
  if (!reportPath) {
    fail('Uso: pnpm suggest:meta-mappings -- --report <salida.csv> [--min-score 0.55] [--limit 3]');
  }
  const minScore = Number(readOption('min-score') ?? 0.5);
  const limit = Number(readOption('limit') ?? 3);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    fail('--min-score debe estar entre 0 y 1.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    fail('--limit debe ser un entero entre 1 y 10.');
  }

  const [metaItems, variants] = await Promise.all([fetchMetaCatalog(), loadVariants()]);
  const rows: Array<Array<string | number>> = [];
  let withCandidates = 0;
  let withoutCandidates = 0;

  for (const item of metaItems) {
    const candidates: Candidate[] = [];
    for (const variant of variants) {
      const candidate = scoreCandidate(item, variant);
      if (candidate && candidate.score >= minScore) {
        candidates.push(candidate);
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      withoutCandidates += 1;
      rows.push([
        item.retailerId,
        item.name,
        item.availability ?? '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'sin candidato',
      ]);
      continue;
    }

    withCandidates += 1;
    for (const candidate of candidates.slice(0, limit)) {
      rows.push([
        item.retailerId,
        item.name,
        item.availability ?? '',
        candidate.variant.idVariante,
        candidate.variant.sku ?? '',
        candidate.variant.productName,
        candidate.variant.color ?? '',
        candidate.variant.isActive ? 'true' : 'false',
        candidate.variant.productActive ? 'true' : 'false',
        candidate.variant.metaRetailerId ?? '',
        candidate.score.toFixed(3),
        candidate.reason,
      ]);
    }
  }

  const header = [
    'retailer_id',
    'meta_name',
    'availability',
    'candidate_variant_id',
    'candidate_sku',
    'candidate_product',
    'candidate_color',
    'candidate_variant_active',
    'candidate_product_active',
    'current_meta_retailer_id',
    'score',
    'reason',
  ];
  const content = [header, ...rows]
    .map((row) => row.map((value) => csvEscape(String(value))).join(','))
    .join('\n');
  const absolutePath = resolve(process.cwd(), reportPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${content}\n`, 'utf8');

  console.log(
    `Meta: ${metaItems.length} items, Altosa: ${variants.length} variantes. ` +
      `Con candidatos: ${withCandidates}, sin candidatos: ${withoutCandidates}.`
  );
  console.log(`Reporte: ${absolutePath}`);
  console.log(
    'No se escribió en la base. Revisa el CSV y genera un archivo sku,retailer_id para el backfill.'
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
