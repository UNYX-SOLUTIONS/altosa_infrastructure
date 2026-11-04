/**
 * Auditoría de paridad Altosa vs Contifico (solo lectura).
 *
 * Compara la base de Altosa (Prisma) contra el catálogo real de Contifico:
 *   - stock de la variante (`especificacionesAdicionales.stock`) vs `cantidad_stock`
 *   - precio (`precioUsd`) vs `pvp1`
 *   - estado (`isActive`) vs `estado` (A/I)
 *   - mapeos rotos: `contifico_id` inexistente, `contifico_sku` distinto al código
 *   - mapeos duplicados (dos variantes apuntando al mismo producto de Contifico)
 *   - variantes activas sin mapeo
 *   - productos de Contifico sin vínculo en Altosa
 *
 * No escribe nada en la base ni en Contifico.
 *
 * Uso (dentro del contenedor, tras `pnpm build`):
 *   docker exec altosa-api node dist/scripts/audit-contifico-parity.js \
 *     --report /tmp/contifico-parity.csv
 *
 * Opciones:
 *   --report <ruta>       CSV detallado (default: data/contifico-parity-report.csv)
 *   --summary <ruta>      JSON con conteos y muestras (opcional)
 *   --only-active         Audita solo variantes activas (más rápido)
 *   --fail-on-mismatch    Sale con código 2 si hay stock/precio/estado distinto,
 *                         mapeos rotos o duplicados
 *   --fail-on-unmapped    Además, falla si hay variantes activas sin mapeo o
 *                         productos de Contifico sin vínculo
 *   --json                Imprime el resumen completo en JSON
 *
 * Desde el host, para copiar el reporte:
 *   docker cp altosa-api:/tmp/contifico-parity.csv ./
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';
import { fetchAllContificoProducts } from '../modules/contifico/contifico-catalog';
import { toNumber } from '../modules/contifico/contifico-mappers';
import type { ContificoProductDto } from '../modules/contifico/contifico-types';
import { buildFlatName, normalizeLooseText } from '../utils/product-naming';

const STOCK_TOLERANCE = 0.001;
const PRICE_TOLERANCE = 0.01;
const SAMPLE_LIMIT = 50;

type MappingVia = 'id' | 'sku' | null;

interface VariantRow {
  idVariante: number;
  idProducto: number;
  sku: string | null;
  color: string | null;
  precioUsd: unknown;
  isActive: boolean;
  contificoId: string | null;
  contificoSku: string | null;
  especificacionesAdicionales: string | null;
  producto: {
    producto: string;
    isActive: boolean;
  };
}

interface ResolvedVariant {
  variant: VariantRow;
  contifico: ContificoProductDto | null;
  via: MappingVia;
  declaredMapping: boolean;
  altosaStock: number | null;
  contificoStock: number | null;
  altosaPrice: number | null;
  contificoPrice: number | null;
  altosaActive: boolean;
  contificoActive: boolean | null;
  stockDiff: number | null;
  priceDiff: number | null;
  issues: string[];
}

interface ParityRow {
  productId: number;
  productName: string;
  productActive: string;
  variantId: number;
  variantColor: string;
  sku: string;
  contificoId: string;
  contificoSku: string;
  mappingVia: string;
  contificoResolvedId: string;
  contificoCode: string;
  contificoName: string;
  contificoEstado: string;
  altosaActive: string;
  contificoActive: string;
  altosaStock: string;
  contificoStock: string;
  stockDiff: string;
  altosaPrice: string;
  contificoPrice: string;
  priceDiff: string;
  issues: string;
}

interface Summary {
  checkedAt: string;
  onlyActive: boolean;
  altosa: Record<string, number>;
  contifico: Record<string, number>;
  issues: Record<string, number>;
  samples: Record<string, unknown[]>;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSpecs(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function numText(value: number | null): string {
  return value === null || value === undefined ? '' : String(value);
}

function diffText(value: number | null): string {
  if (value === null) {
    return '';
  }
  return String(Math.round(value * 10000) / 10000);
}

function formatSampleStock(item: ResolvedVariant): string {
  return [
    `[${item.variant.producto.producto} / ${item.variant.color ?? '-'} / SKU ${item.variant.sku ?? '-'}]`,
    `Altosa=${numText(item.altosaStock) || 'vacío'}`,
    `Contifico=${numText(item.contificoStock) || 'vacío'}`,
    `diferencia=${diffText(item.stockDiff) || '-'}`,
    `activa=${item.altosaActive ? 'SI' : 'NO'}`,
  ].join(' ');
}

function formatSampleStatus(item: ResolvedVariant): string {
  return [
    `[${item.variant.producto.producto} / ${item.variant.color ?? '-'} / SKU ${item.variant.sku ?? '-'}]`,
    `Altosa=${item.altosaActive ? 'ACTIVA' : 'INACTIVA'}`,
    `Contifico=${item.contifico?.estado ?? '-'}`,
  ].join(' ');
}

function formatSampleMissing(item: ResolvedVariant): string {
  return [
    `[${item.variant.producto.producto} / ${item.variant.color ?? '-'}]`,
    `SKU=${item.variant.sku ?? '-'}`,
    `contifico_id=${item.variant.contificoId ?? '-'}`,
    `contifico_sku=${item.variant.contificoSku ?? '-'}`,
    `activa=${item.altosaActive ? 'SI' : 'NO'}`,
  ].join(' ');
}

function buildSummary(
  variants: ResolvedVariant[],
  contificoProducts: ContificoProductDto[],
  linkedContificoIds: Set<string>,
  unlinkedContifico: Array<{
    product: ContificoProductDto;
    skuCandidate: VariantRow | null;
    nameCandidate: VariantRow | null;
  }>,
  onlyActive: boolean
): Summary {
  const stockMismatches = variants.filter((item) => item.issues.includes('stock_distinto'));
  const priceMismatches = variants.filter((item) => item.issues.includes('precio_distinto'));
  const statusMismatches = variants.filter((item) => item.issues.includes('estado_distinto'));
  const missingInContifico = variants.filter((item) =>
    item.issues.includes('mapeado_no_existe_en_contifico')
  );
  const mappingMismatches = variants.filter(
    (item) =>
      item.issues.includes('mapeo_por_sku_id_no_encontrado') ||
      item.issues.includes('contificoSku_distinto')
  );
  const duplicateMappings = variants.filter((item) => item.issues.includes('mapeo_duplicado'));
  const activeWithoutMapping = variants.filter(
    (item) => item.altosaActive && !item.declaredMapping && !item.contifico
  );
  const activeWithoutMappingWithCandidate = variants.filter(
    (item) =>
      item.altosaActive &&
      !item.declaredMapping &&
      Boolean(item.contifico) &&
      item.via === 'sku'
  );
  const activeWithInactiveParent = variants.filter(
    (item) => item.altosaActive && !item.variant.producto.isActive
  );
  const activeInactiveInContifico = statusMismatches.filter(
    (item) => item.altosaActive && item.contificoActive === false
  );
  const inactiveActiveInContifico = statusMismatches.filter(
    (item) => !item.altosaActive && item.contificoActive === true
  );
  const unlinkedActive = unlinkedContifico.filter((item) => item.product.estado !== 'I');
  const unlinkedInactive = unlinkedContifico.filter((item) => item.product.estado === 'I');

  const productSummary = new Map<
    number,
    {
      productId: number;
      productName: string;
      productActive: boolean;
      totalVariants: number;
      activeVariants: number;
    }
  >();
  for (const item of variants) {
    const current = productSummary.get(item.variant.idProducto) ?? {
      productId: item.variant.idProducto,
      productName: item.variant.producto.producto,
      productActive: item.variant.producto.isActive,
      totalVariants: 0,
      activeVariants: 0,
    };
    current.totalVariants += 1;
    if (item.altosaActive) {
      current.activeVariants += 1;
    }
    productSummary.set(item.variant.idProducto, current);
  }
  const activeProductsWithoutActiveVariants = [...productSummary.values()].filter(
    (product) => product.productActive && product.activeVariants === 0
  );

  return {
    checkedAt: new Date().toISOString(),
    onlyActive,
    altosa: {
      products: new Set(variants.map((item) => item.variant.idProducto)).size,
      variants: variants.length,
      activeVariants: variants.filter((item) => item.altosaActive).length,
      inactiveVariants: variants.filter((item) => !item.altosaActive).length,
      mappedVariants: variants.filter((item) => item.declaredMapping).length,
      activeMappedVariants: variants.filter(
        (item) => item.altosaActive && item.declaredMapping
      ).length,
      activeUnmappedVariants: activeWithoutMapping.length,
      activeUnmappedWithSkuCandidate: activeWithoutMappingWithCandidate.length,
    },
    contifico: {
      products: contificoProducts.length,
      active: contificoProducts.filter((item) => item.estado !== 'I').length,
      inactive: contificoProducts.filter((item) => item.estado === 'I').length,
      linkedToAltosa: linkedContificoIds.size,
      unlinked: unlinkedContifico.length,
      unlinkedActive: unlinkedActive.length,
      unlinkedInactive: unlinkedInactive.length,
    },
    issues: {
      stockMismatches: stockMismatches.length,
      stockMismatchesActive: stockMismatches.filter((item) => item.altosaActive).length,
      priceMismatches: priceMismatches.length,
      statusMismatches: statusMismatches.length,
      activeInAltosaInactiveInContifico: activeInactiveInContifico.length,
      inactiveInAltosaActiveInContifico: inactiveActiveInContifico.length,
      missingInContifico: missingInContifico.length,
      mappingMismatches: mappingMismatches.length,
      duplicateMappings: duplicateMappings.length,
      activeVariantWithInactiveParent: activeWithInactiveParent.length,
      activeProductsWithoutActiveVariants: activeProductsWithoutActiveVariants.length,
      activeVariantsWithoutMapping: activeWithoutMapping.length,
      activeVariantsWithoutMappingWithSkuCandidate: activeWithoutMappingWithCandidate.length,
    },
    samples: {
      stockMismatches: stockMismatches.slice(0, SAMPLE_LIMIT).map(formatSampleStock),
      statusMismatches: statusMismatches.slice(0, SAMPLE_LIMIT).map(formatSampleStatus),
      activeProductsWithoutActiveVariants: activeProductsWithoutActiveVariants
        .slice(0, SAMPLE_LIMIT)
        .map(
          (product) =>
            `[${product.productId}] ${product.productName} (variantes totales: ${product.totalVariants}, activas: ${product.activeVariants})`
        ),
      missingInContifico: missingInContifico.slice(0, SAMPLE_LIMIT).map(formatSampleMissing),
      activeVariantsWithoutMapping: activeWithoutMapping
        .slice(0, SAMPLE_LIMIT)
        .map(formatSampleMissing),
      unlinkedContificoActive: unlinkedActive.slice(0, SAMPLE_LIMIT).map((item) => ({
        id: item.product.id,
        codigo: item.product.codigo,
        nombre: item.product.nombre,
        stock: toNumber(item.product.cantidad_stock),
        pvp1: toNumber(item.product.pvp1),
        skuCandidate: item.skuCandidate?.sku ?? null,
        nameCandidate: item.nameCandidate
          ? `${item.nameCandidate.producto.producto} / ${item.nameCandidate.color ?? '-'}`
          : null,
      })),
      unlinkedContificoInactive: unlinkedInactive.slice(0, SAMPLE_LIMIT).map((item) => ({
        id: item.product.id,
        codigo: item.product.codigo,
        nombre: item.product.nombre,
        stock: toNumber(item.product.cantidad_stock),
        pvp1: toNumber(item.product.pvp1),
      })),
    },
  };
}

async function main(): Promise<void> {
  const reportPath = readOption('report') ?? 'data/contifico-parity-report.csv';
  const summaryPath = readOption('summary');
  const onlyActive = process.argv.includes('--only-active');
  const failOnMismatch = process.argv.includes('--fail-on-mismatch');
  const failOnUnmapped = process.argv.includes('--fail-on-unmapped');
  const jsonOutput = process.argv.includes('--json');

  const prisma = getPrisma();

  const variants = (await prisma.productoVariante.findMany({
    where: onlyActive ? { isActive: true } : undefined,
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      precioUsd: true,
      isActive: true,
      contificoId: true,
      contificoSku: true,
      especificacionesAdicionales: true,
      producto: { select: { producto: true, isActive: true } },
    },
    orderBy: { idVariante: 'asc' },
  })) as VariantRow[];

  const contificoProducts = await fetchAllContificoProducts();

  const contificoById = new Map<string, ContificoProductDto>();
  const contificoBySku = new Map<string, ContificoProductDto>();
  for (const product of contificoProducts) {
    contificoById.set(normalize(product.id), product);
    if (product.codigo) {
      contificoBySku.set(normalize(product.codigo), product);
    }
  }

  function resolveContifico(variant: VariantRow): {
    product: ContificoProductDto | null;
    via: MappingVia;
  } {
    if (variant.contificoId) {
      const byId = contificoById.get(normalize(variant.contificoId));
      if (byId) {
        return { product: byId, via: 'id' };
      }
    }
    const code = variant.contificoSku ?? variant.sku;
    if (code) {
      const bySku = contificoBySku.get(normalize(code));
      if (bySku) {
        return { product: bySku, via: 'sku' };
      }
    }
    return { product: null, via: null };
  }

  const resolved: ResolvedVariant[] = [];
  const resolvedByContificoId = new Map<string, ResolvedVariant[]>();

  for (const variant of variants) {
    const specs = parseSpecs(variant.especificacionesAdicionales);
    const altosaStock = toNumber(specs.stock);
    const altosaPrice = toNumber(variant.precioUsd);
    const altosaActive = Boolean(variant.isActive);
    const declaredMapping = Boolean(variant.contificoId || variant.contificoSku);
    const { product: contifico, via } = resolveContifico(variant);
    const contificoStock = contifico ? toNumber(contifico.cantidad_stock) : null;
    const contificoPrice = contifico ? toNumber(contifico.pvp1) : null;
    const contificoActive = contifico ? contifico.estado !== 'I' : null;
    const stockDiff =
      altosaStock !== null && contificoStock !== null
        ? altosaStock - contificoStock
        : null;
    const priceDiff =
      altosaPrice !== null && contificoPrice !== null
        ? altosaPrice - contificoPrice
        : null;

    const issues: string[] = [];

    if (declaredMapping && !contifico) {
      issues.push('mapeado_no_existe_en_contifico');
    }
    if (declaredMapping && contifico && via !== 'id') {
      issues.push('mapeo_por_sku_id_no_encontrado');
    }
    if (
      declaredMapping &&
      contifico &&
      variant.contificoSku &&
      normalize(contifico.codigo) !== normalize(variant.contificoSku)
    ) {
      issues.push('contificoSku_distinto');
    }
    if (!declaredMapping) {
      if (!contifico && altosaActive) {
        issues.push('variante_activa_sin_mapeo');
      }
      if (contifico && altosaActive && via === 'sku') {
        issues.push('variante_activa_sin_mapeo_con_candidato');
      }
    }
    if (contifico) {
      if (stockDiff !== null && Math.abs(stockDiff) > STOCK_TOLERANCE) {
        issues.push('stock_distinto');
      }
      if (altosaStock === null && contificoStock !== null) {
        issues.push('stock_altosa_vacio');
      }
      if (priceDiff !== null && Math.abs(priceDiff) > PRICE_TOLERANCE) {
        issues.push('precio_distinto');
      }
      if (altosaActive !== contificoActive) {
        issues.push('estado_distinto');
      }
    }
    if (altosaActive && !variant.producto.isActive) {
      issues.push('variante_activa_producto_inactivo');
    }

    const item: ResolvedVariant = {
      variant,
      contifico,
      via,
      declaredMapping,
      altosaStock,
      contificoStock,
      altosaPrice,
      contificoPrice,
      altosaActive,
      contificoActive,
      stockDiff,
      priceDiff,
      issues,
    };
    resolved.push(item);

    if (contifico) {
      const key = normalize(contifico.id);
      const group = resolvedByContificoId.get(key);
      if (group) {
        group.push(item);
      } else {
        resolvedByContificoId.set(key, [item]);
      }
    }
  }

  for (const group of resolvedByContificoId.values()) {
    if (group.length > 1) {
      for (const item of group) {
        if (!item.issues.includes('mapeo_duplicado')) {
          item.issues.push('mapeo_duplicado');
        }
      }
    }
  }

  const variantsBySku = new Map<string, VariantRow>();
  const variantsByName = new Map<string, VariantRow>();
  for (const variant of variants) {
    if (variant.sku) {
      variantsBySku.set(normalize(variant.sku), variant);
    }
    if (variant.contificoSku) {
      variantsBySku.set(normalize(variant.contificoSku), variant);
    }
    variantsByName.set(
      normalizeLooseText(buildFlatName(variant.producto.producto, variant.color)),
      variant
    );
    variantsByName.set(normalizeLooseText(variant.producto.producto), variant);
  }

  const unlinkedContifico = contificoProducts
    .filter((product) => !resolvedByContificoId.has(normalize(product.id)))
    .map((product) => ({
      product,
      skuCandidate: product.codigo
        ? variantsBySku.get(normalize(product.codigo)) ?? null
        : null,
      nameCandidate: variantsByName.get(normalizeLooseText(product.nombre)) ?? null,
    }));

  const summary = buildSummary(
    resolved,
    contificoProducts,
    new Set(resolvedByContificoId.keys()),
    unlinkedContifico,
    onlyActive
  );

  const parityRows: ParityRow[] = resolved.map((item) => ({
    productId: item.variant.idProducto,
    productName: item.variant.producto.producto,
    productActive: item.variant.producto.isActive ? 'SI' : 'NO',
    variantId: item.variant.idVariante,
    variantColor: item.variant.color ?? '',
    sku: item.variant.sku ?? '',
    contificoId: item.variant.contificoId ?? '',
    contificoSku: item.variant.contificoSku ?? '',
    mappingVia: item.via ?? '',
    contificoResolvedId: item.contifico?.id ?? '',
    contificoCode: item.contifico?.codigo ?? '',
    contificoName: item.contifico?.nombre ?? '',
    contificoEstado: item.contifico?.estado ?? '',
    altosaActive: item.altosaActive ? 'SI' : 'NO',
    contificoActive:
      item.contificoActive === null ? 'NO_ENCONTRADO' : item.contificoActive ? 'SI' : 'NO',
    altosaStock: numText(item.altosaStock),
    contificoStock: numText(item.contificoStock),
    stockDiff: diffText(item.stockDiff),
    altosaPrice: numText(item.altosaPrice),
    contificoPrice: numText(item.contificoPrice),
    priceDiff: diffText(item.priceDiff),
    issues: item.issues.join('|'),
  }));

  const headers: Array<keyof ParityRow> = [
    'productId',
    'productName',
    'productActive',
    'variantId',
    'variantColor',
    'sku',
    'contificoId',
    'contificoSku',
    'mappingVia',
    'contificoResolvedId',
    'contificoCode',
    'contificoName',
    'contificoEstado',
    'altosaActive',
    'contificoActive',
    'altosaStock',
    'contificoStock',
    'stockDiff',
    'altosaPrice',
    'contificoPrice',
    'priceDiff',
    'issues',
  ];
  const csv = [
    headers.join(','),
    ...parityRows.map((row) =>
      headers.map((header) => csvEscape(row[header])).join(',')
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

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          checkedAt: summary.checkedAt,
          altosa: summary.altosa,
          contifico: summary.contifico,
          issues: summary.issues,
        },
        null,
        2
      )
    );
  }
  console.log(`Reporte CSV: ${absoluteReportPath}`);
  if (summaryPath) {
    console.log(`Resumen JSON: ${resolve(process.cwd(), summaryPath)}`);
  }

  const coreIssueCount =
    summary.issues.stockMismatches +
    summary.issues.priceMismatches +
    summary.issues.statusMismatches +
    summary.issues.missingInContifico +
    summary.issues.mappingMismatches +
    summary.issues.duplicateMappings +
    summary.issues.activeVariantWithInactiveParent +
    summary.issues.activeProductsWithoutActiveVariants;
  const unmappedIssueCount =
    summary.issues.activeVariantsWithoutMapping + summary.contifico.unlinkedActive;

  if (failOnMismatch && coreIssueCount > 0) {
    process.exitCode = 2;
  }
  if (failOnUnmapped && unmappedIssueCount > 0) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(async () => {
    await disconnectPrisma();
  });
