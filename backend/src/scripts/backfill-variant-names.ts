/**
 * Backfill de `product_variants.nombre` (nombre completo visible en el ERP).
 *
 * Regla:
 *   1. Si la variante tiene un override manual (ID o SKU), se usa ese nombre.
 *   2. Si no tiene color (o es "Estándar") y el producto tiene varias
 *      variantes, se usa el slug de `url_producto` como nombre real:
 *      /producto/base-redonda-eco/ -> "Base Redonda Eco".
 *   3. Si no hay URL, se usan los fallbacks de bases sin color.
 *   4. Si `color` es NULL/vacío o "Estándar": nombre = nombre del producto.
 *   5. Si el nombre del producto ya contiene el color: nombre = producto.
 *   6. En otro caso: nombre = producto + " " + color.
 *   7. Si dos variantes del mismo producto quedan con el mismo nombre, se
 *      agrega el SKU (o `v<id>` si no hay SKU) para desambiguar.
 *
 * No sobreescribe nombres existentes salvo que se pase `--force`.
 * Por defecto es dry-run; los cambios se aplican con `--apply`.
 *
 * Uso (dentro del contenedor, tras `pnpm build` y la migración):
 *   docker exec altosa-api node dist/scripts/backfill-variant-names.js \
 *     --report /tmp/variant-names.csv
 *   docker exec altosa-api node dist/scripts/backfill-variant-names.js \
 *     --apply --report /tmp/variant-names.csv
 *
 * Opciones:
 *   --apply              Escribe los nombres en la BD (sin esto es dry-run)
 *   --force              Regenera también los nombres que ya existen
 *   --report <ruta>      CSV de revisión (default: data/variant-names-backfill.csv)
 *   --summary <ruta>     JSON con conteos y muestras
 *   --overrides <ruta>   CSV extra: variant_id o sku + nombre
 *   --limit <n>          Limita la cantidad de variantes procesadas (pruebas)
 *
 * Overrides incluidos para las bases sin color (8 variantes):
 *   Base Redonda: 178/FT-B121-1, 180/FT-B122-1, 230/v230, 243/FT-B153B
 *   Base Cuadrada: 179/FT-B121-2, 181/FT-B122-2
 *   Base Cruz: 182/FT-B071, 244/X-BASE5
 * Esos nombres se pueden ajustar con `--overrides` sin tocar el código.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';
import { buildFlatName, normalizeLooseText } from '../utils/product-naming';

const REPORT_DEFAULT = 'data/variant-names-backfill.csv';

interface VariantRow {
  idVariante: number;
  idProducto: number;
  sku: string | null;
  color: string | null;
  nombre: string | null;
  urlProducto: string | null;
  producto: {
    producto: string;
  };
}

interface OverrideRule {
  variantId?: number;
  sku?: string;
  name: string;
}

interface ResolvedName {
  variant: VariantRow;
  currentName: string;
  proposedName: string;
  finalName: string;
  source: string;
  action: 'keep' | 'fill' | 'update';
  duplicate: boolean;
}

/**
 * Fallbacks para las bases sin color. Si la variante tiene `url_producto`
 * (ej. /producto/base-redonda-eco/), el slug tiene prioridad porque es el
 * nombre real de la variante en el sitio. Estos valores solo se usan cuando
 * no hay URL o cuando el slug no aporta un nombre útil.
 */
const BUILTIN_OVERRIDES: OverrideRule[] = [
  { variantId: 178, sku: 'FT-B121-1', name: 'Base Redonda 45 × 77 × 43 cm' },
  { variantId: 180, sku: 'FT-B122-1', name: 'Base Redonda 45 × 69 × 44 cm' },
  { variantId: 230, name: 'Base Redonda 45 × 73 × 58 cm' },
  { variantId: 243, sku: 'FT-B153B', name: 'Base Redonda 45 × 73 × 50 cm' },
  { variantId: 179, sku: 'FT-B121-2', name: 'Base Cuadrada Acero' },
  { variantId: 181, sku: 'FT-B122-2', name: 'Base Cuadrada Hierro Fundido' },
  { variantId: 182, sku: 'FT-B071', name: 'Base Cruz Hierro Fundido' },
  { variantId: 244, sku: 'X-BASE5', name: 'Base Cruz Acero' },
];

const CONNECTORS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'y',
  'para',
  'en',
  'por',
  'sin',
  'a',
  'al',
]);

function slugToName(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const withoutQuery = url.split('?')[0]?.split('#')[0] ?? '';
  const segments = withoutQuery.split('/').filter(Boolean);
  let slug = segments[segments.length - 1] ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Si el slug viene mal codificado, se usa tal cual.
  }
  slug = slug.replace(/\.(html?|php)$/i, '').trim();
  if (!slug || /^(producto|productos|tienda|shop)$/i.test(slug)) {
    return null;
  }
  const words = slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) {
    return null;
  }
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && CONNECTORS.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function readOption(name: string): string | null {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const withEquals = args.find((arg) => arg.startsWith(prefix));
  if (withEquals) {
    return withEquals.slice(prefix.length);
  }
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    return args[index + 1] ?? null;
  }
  return null;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeSku(value: string | null | undefined): string {
  return clean(value).toUpperCase();
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildOverrideIndex(
  rules: OverrideRule[]
): { byId: Map<number, string>; bySku: Map<string, string> } {
  const byId = new Map<number, string>();
  const bySku = new Map<string, string>();
  for (const rule of rules) {
    if (rule.variantId !== undefined) {
      byId.set(rule.variantId, rule.name);
    }
    if (rule.sku) {
      bySku.set(normalizeSku(rule.sku), rule.name);
    }
  }
  return { byId, bySku };
}

async function loadExtraOverrides(
  file: string | null
): Promise<OverrideRule[]> {
  if (!file) {
    return [];
  }
  const content = await readFile(resolve(process.cwd(), file), 'utf8');
  const rules: OverrideRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/[;,]/).map((part) => part.trim());
    if (parts.length < 2) {
      continue;
    }
    const [key, ...nameParts] = parts;
    const name = clean(nameParts.join(' '));
    if (!key || !name || /^(variant_id|id|sku)$/i.test(key)) {
      continue;
    }
    if (/^\d+$/.test(key)) {
      rules.push({ variantId: Number(key), name });
    } else {
      rules.push({ sku: key, name });
    }
  }
  return rules;
}

function generateName(
  variant: VariantRow,
  manualOverrides: { byId: Map<number, string>; bySku: Map<string, string> },
  fallbackOverrides: { byId: Map<number, string>; bySku: Map<string, string> },
  useUrlForNoColor: boolean
): { name: string; source: string } {
  const productName = clean(variant.producto.producto);
  const color = clean(variant.color);
  const manualOverride =
    manualOverrides.byId.get(variant.idVariante) ??
    (variant.sku ? manualOverrides.bySku.get(normalizeSku(variant.sku)) : undefined);

  if (manualOverride) {
    return { name: clean(manualOverride), source: 'override_manual' };
  }

  const noColor = !color || /^est[aá]ndar$/i.test(color);
  if (noColor && useUrlForNoColor) {
    const urlName = slugToName(variant.urlProducto);
    if (urlName) {
      return { name: urlName, source: 'url' };
    }
  }

  const fallbackOverride =
    fallbackOverrides.byId.get(variant.idVariante) ??
    (variant.sku
      ? fallbackOverrides.bySku.get(normalizeSku(variant.sku))
      : undefined);
  if (fallbackOverride) {
    return { name: clean(fallbackOverride), source: 'override' };
  }

  if (noColor) {
    return { name: productName, source: color ? 'estandar' : 'sin_color' };
  }

  const alreadyContainsColor = normalizeLooseText(productName).includes(
    normalizeLooseText(color)
  );
  return {
    name: clean(buildFlatName(productName, color)),
    source: alreadyContainsColor ? 'producto_incluye_color' : 'producto_color',
  };
}

function suffixFor(variant: VariantRow): string {
  const sku = clean(variant.sku);
  return sku || `v${variant.idVariante}`;
}

function resolveNames(
  variants: VariantRow[],
  manualOverrides: { byId: Map<number, string>; bySku: Map<string, string> },
  fallbackOverrides: { byId: Map<number, string>; bySku: Map<string, string> },
  force: boolean
): ResolvedName[] {
  const variantCountByProduct = new Map<number, number>();
  for (const variant of variants) {
    variantCountByProduct.set(
      variant.idProducto,
      (variantCountByProduct.get(variant.idProducto) ?? 0) + 1
    );
  }

  const resolved = variants.map<ResolvedName>((variant) => {
    const currentName = clean(variant.nombre);
    const generated = generateName(
      variant,
      manualOverrides,
      fallbackOverrides,
      (variantCountByProduct.get(variant.idProducto) ?? 0) > 1
    );
    if (currentName && !force) {
      return {
        variant,
        currentName,
        proposedName: generated.name,
        finalName: currentName,
        source: 'existente',
        action: 'keep',
        duplicate: false,
      };
    }
    return {
      variant,
      currentName,
      proposedName: generated.name,
      finalName: generated.name,
      source: generated.source,
      action: currentName ? 'update' : 'fill',
      duplicate: false,
    };
  });

  const byProduct = new Map<number, ResolvedName[]>();
  for (const item of resolved) {
    const group = byProduct.get(item.variant.idProducto);
    if (group) {
      group.push(item);
    } else {
      byProduct.set(item.variant.idProducto, [item]);
    }
  }

  for (const group of byProduct.values()) {
    const used = new Set<string>();
    for (const item of group.filter((entry) => entry.action === 'keep')) {
      used.add(normalizeLooseText(item.finalName));
    }

    for (const item of group.filter((entry) => entry.action !== 'keep')) {
      let candidate = item.finalName;
      const normalized = normalizeLooseText(candidate);
      if (used.has(normalized)) {
        const suffix = suffixFor(item.variant);
        candidate = `${candidate} (${suffix})`;
        item.duplicate = true;
        if (used.has(normalizeLooseText(candidate))) {
          candidate = `${candidate} (v${item.variant.idVariante})`;
        }
      }
      used.add(normalizeLooseText(candidate));
      item.finalName = candidate;
    }
  }

  return resolved;
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const reportPath = readOption('report') ?? REPORT_DEFAULT;
  const summaryPath = readOption('summary');
  const overridesPath = readOption('overrides');
  const limitRaw = readOption('limit');
  const limit = limitRaw ? Number(limitRaw) : null;

  const variants = (await prisma.productoVariante.findMany({
    ...(limit && Number.isFinite(limit) && limit > 0 ? { take: limit } : {}),
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      nombre: true,
      urlProducto: true,
      producto: { select: { producto: true } },
    },
    orderBy: { idVariante: 'asc' },
  })) as VariantRow[];

  const extraOverrides = await loadExtraOverrides(overridesPath);
  const manualOverrides = buildOverrideIndex(extraOverrides);
  const fallbackOverrides = buildOverrideIndex(BUILTIN_OVERRIDES);
  const resolved = resolveNames(
    variants,
    manualOverrides,
    fallbackOverrides,
    force
  );

  const toUpdate = resolved.filter(
    (item) =>
      (item.action === 'fill' || item.action === 'update') &&
      item.finalName !== item.currentName
  );
  const emptyAfter = resolved.filter((item) => !item.finalName);
  const duplicates = resolved.filter((item) => item.duplicate);
  const manualOverrideCount = resolved.filter(
    (item) => item.source === 'override_manual'
  ).length;
  const fallbackOverrideCount = resolved.filter(
    (item) => item.source === 'override'
  ).length;
  const urlNameCount = resolved.filter((item) => item.source === 'url').length;

  const sourceCounts: Record<string, number> = {};
  for (const item of resolved) {
    sourceCounts[item.source] = (sourceCounts[item.source] ?? 0) + 1;
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    applied: apply,
    forced: force,
    limit,
    totalVariants: resolved.length,
    toUpdate: toUpdate.length,
    fill: resolved.filter((item) => item.action === 'fill').length,
    update: resolved.filter((item) => item.action === 'update').length,
    kept: resolved.filter((item) => item.action === 'keep').length,
    duplicatesDisambiguated: duplicates.length,
    overridesUsed: manualOverrideCount + fallbackOverrideCount,
    manualOverridesUsed: manualOverrideCount,
    fallbackOverridesUsed: fallbackOverrideCount,
    urlNamesUsed: urlNameCount,
    emptyAfter,
    sourceCounts,
    samples: {
      fills: resolved
        .filter((item) => item.action === 'fill')
        .slice(0, 40)
        .map((item) => ({
          idVariante: item.variant.idVariante,
          producto: item.variant.producto.producto,
          sku: item.variant.sku,
          color: item.variant.color,
          nombre: item.finalName,
          source: item.source,
        })),
      duplicates: duplicates.slice(0, 40).map((item) => ({
        idVariante: item.variant.idVariante,
        producto: item.variant.producto.producto,
        sku: item.variant.sku,
        color: item.variant.color,
        nombre: item.finalName,
      })),
    },
  };

  const headers = [
    'idVariante',
    'idProducto',
    'producto',
    'sku',
    'color',
    'nombreActual',
    'nombrePropuesto',
    'nombreFinal',
    'accion',
    'origen',
    'duplicado',
  ];
  const csv = [
    headers.join(','),
    ...resolved.map((item) =>
      [
        item.variant.idVariante,
        item.variant.idProducto,
        item.variant.producto.producto,
        item.variant.sku,
        item.variant.color,
        item.currentName,
        item.proposedName,
        item.finalName,
        item.action,
        item.source,
        item.duplicate ? 'SI' : 'NO',
      ]
        .map(csvEscape)
        .join(',')
    ),
  ].join('\n');

  const absoluteReportPath = resolve(process.cwd(), reportPath);
  await mkdir(dirname(absoluteReportPath), { recursive: true });
  await writeFile(absoluteReportPath, `${csv}\n`, 'utf8');

  if (summaryPath) {
    const absoluteSummaryPath = resolve(process.cwd(), summaryPath);
    await mkdir(dirname(absoluteSummaryPath), { recursive: true });
    await writeFile(
      absoluteSummaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8'
    );
  }

  if (apply && toUpdate.length > 0) {
    const chunkSize = 100;
    for (let index = 0; index < toUpdate.length; index += chunkSize) {
      const chunk = toUpdate.slice(index, index + chunkSize);
      await prisma.$transaction(
        chunk.map((item) =>
          prisma.productoVariante.update({
            where: { idVariante: item.variant.idVariante },
            data: { nombre: item.finalName },
          })
        )
      );
      process.stderr.write(
        `  actualizadas ${Math.min(index + chunkSize, toUpdate.length)}/${toUpdate.length}\n`
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        checkedAt: summary.checkedAt,
        applied: summary.applied,
        forced: summary.forced,
        totalVariants: summary.totalVariants,
        toUpdate: summary.toUpdate,
        fill: summary.fill,
        update: summary.update,
        kept: summary.kept,
        duplicatesDisambiguated: summary.duplicatesDisambiguated,
        overridesUsed: summary.overridesUsed,
        manualOverridesUsed: summary.manualOverridesUsed,
        fallbackOverridesUsed: summary.fallbackOverridesUsed,
        urlNamesUsed: summary.urlNamesUsed,
        emptyAfter: summary.emptyAfter.length,
        sourceCounts: summary.sourceCounts,
      },
      null,
      2
    )
  );
  console.log(`Reporte CSV: ${absoluteReportPath}`);
  if (summaryPath) {
    console.log(`Resumen JSON: ${resolve(process.cwd(), summaryPath)}`);
  }
  if (!apply) {
    console.log('DRY-RUN: no se escribió nada. Usa --apply para aplicar.');
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/column.*nombre|nombre.*column/i.test(message)) {
      console.error(
        `ERROR: falta la columna product_variants.nombre. Ejecuta scripts/apply-variant-nombre-migration.sh.\n${message}`
      );
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
