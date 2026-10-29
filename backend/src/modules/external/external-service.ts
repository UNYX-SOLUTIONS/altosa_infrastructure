import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';
import {
  inferBaseName,
  inferVariantColor,
} from '../../utils/product-naming';
import { resolveSyncEstados } from '../catalog/catalog-estados';
import {
  fetchAllContificoProducts,
  fetchContificoCategories,
} from '../contifico/contifico-catalog';
import { mapContificoProduct } from '../contifico/contifico-mappers';
import { listPendingMetaItems } from '../meta/meta-service';
import type {
  ExternalItemInput,
  ExternalMetaPendingQuery,
  ExternalPendingQuery,
} from './external-schema';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

async function findMappedVariant(item: ExternalItemInput) {
  const prisma = getPrisma();
  const or: Prisma.ProductoVarianteWhereInput[] = [];

  const metaRetailerId =
    item.metaRetailerId ?? (item.source === 'meta' ? item.externalId : null);
  const contificoId =
    item.contificoId ?? (item.source === 'contifico' ? item.externalId : null);
  const contificoSku =
    item.contificoSku ??
    (item.source === 'contifico' ? item.sku ?? item.externalId : null);

  if (metaRetailerId) {
    or.push({ metaRetailerId: { equals: metaRetailerId, mode: 'insensitive' } });
  }
  if (contificoId) {
    or.push({ contificoId: { equals: contificoId, mode: 'insensitive' } });
  }
  if (contificoSku) {
    or.push({ contificoSku: { equals: contificoSku, mode: 'insensitive' } });
  }
  if (item.sku?.trim()) {
    or.push({ sku: item.sku.trim() });
  }

  return prisma.productoVariante.findFirst({
    where: { OR: or },
    select: { idVariante: true, idProducto: true, sku: true },
  });
}

async function resolveUniqueSku(base: string): Promise<string> {
  const prisma = getPrisma();
  const clean = base.trim().slice(0, 120) || `EXT-${Date.now()}`;
  let candidate = clean;
  let suffix = 2;

  while (
    await prisma.productoVariante.findFirst({
      where: { sku: candidate },
      select: { idVariante: true },
    })
  ) {
    const suffixText = `-${suffix}`;
    candidate = `${clean.slice(0, Math.max(1, 120 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }

  return candidate;
}

async function resolveTaxonomy(item: ExternalItemInput): Promise<number> {
  const prisma = getPrisma();
  const categoryName = item.category?.trim() || 'Catálogo externo';
  const subcategoryName =
    item.subcategory?.trim() || (item.source === 'meta' ? 'Meta' : 'Contifico');

  const categoria =
    (await prisma.categoria.findFirst({
      where: { nombre: { equals: categoryName, mode: 'insensitive' } },
    })) ??
    (await prisma.categoria.create({
      data: { nombre: categoryName },
    }));

  const subcategoria =
    (await prisma.subcategoria.findFirst({
      where: {
        idCategoria: categoria.id,
        nombre: { equals: subcategoryName, mode: 'insensitive' },
      },
    })) ??
    (await prisma.subcategoria.create({
      data: { idCategoria: categoria.id, nombre: subcategoryName },
    }));

  return subcategoria.id;
}

export interface ExternalImportResult {
  productsCreated: number;
  productsReused: number;
  variantsCreated: number;
  variantsSkipped: number;
  created: Array<{
    productId: number;
    productName: string;
    variantId: number;
    sku: string;
  }>;
  errors: string[];
}

export async function importExternalItems(
  items: ExternalItemInput[]
): Promise<ExternalImportResult> {
  const prisma = getPrisma();
  const estados = await resolveSyncEstados();
  const result: ExternalImportResult = {
    productsCreated: 0,
    productsReused: 0,
    variantsCreated: 0,
    variantsSkipped: 0,
    created: [],
    errors: [],
  };
  const seen = new Set<string>();

  for (const item of items) {
    const batchKey = `${item.source}:${normalize(item.externalId)}`;
    if (seen.has(batchKey)) {
      result.variantsSkipped += 1;
      continue;
    }
    seen.add(batchKey);

    try {
      const alreadyMapped = await findMappedVariant(item);
      if (alreadyMapped) {
        result.variantsSkipped += 1;
        continue;
      }

      const baseName = item.baseName?.trim() || inferBaseName(item.name);
      const inferredColor =
        item.color?.trim() || inferVariantColor(item.name, baseName);
      let product = await prisma.producto.findFirst({
        where: { producto: { equals: baseName, mode: 'insensitive' } },
        select: { idProducto: true, producto: true },
      });

      if (product) {
        result.productsReused += 1;
      } else {
        const idSubCategoria = await resolveTaxonomy(item);
        product = await prisma.producto.create({
          data: {
            idSubCategoria,
            producto: baseName,
            descripcion: item.name,
            estadoId: estados.inactiveId,
            isActive: false,
          },
          select: { idProducto: true, producto: true },
        });
        result.productsCreated += 1;
      }

      const baseSku =
        item.sku?.trim() ||
        item.contificoSku?.trim() ||
        `${item.source === 'meta' ? 'META' : 'CON'}-${item.externalId}`;
      const sku = await resolveUniqueSku(baseSku);
      const metaRetailerId =
        item.metaRetailerId ?? (item.source === 'meta' ? item.externalId : null);
      const contificoId =
        item.contificoId ?? (item.source === 'contifico' ? item.externalId : null);
      const contificoSku =
        item.contificoSku ??
        (item.source === 'contifico' ? item.sku ?? item.externalId : null);
      const variant = await prisma.productoVariante.create({
        data: {
          idProducto: product.idProducto,
          sku,
          color: inferredColor || item.name,
          descripcion: item.name,
          precioUsd: item.price ?? null,
          imagenUrl: item.imageUrl || null,
          urlProducto: item.url || null,
          estadoId: estados.inactiveId,
          // Regla de ingesta: nada entra aprobado; un humano lo revisa en el ERP.
          isActive: false,
          ...(metaRetailerId
            ? {
                metaRetailerId,
                metaMappingLocked: true,
              }
            : {}),
          ...(contificoId
            ? {
                contificoId,
                contificoSku: contificoSku || item.externalId,
              }
            : {}),
          especificacionesAdicionales: JSON.stringify({
            origen: item.source,
            external_id: item.externalId,
            ...(metaRetailerId ? { meta_retailer_id: metaRetailerId } : {}),
            ...(contificoId ? { contifico_id: contificoId } : {}),
            ...(item.barcode ? { codigo_barra: item.barcode } : {}),
            ...(item.stock !== undefined && item.stock !== null
              ? { stock: item.stock }
              : {}),
          }),
        },
        select: { idVariante: true, sku: true },
      });

      result.variantsCreated += 1;
      result.created.push({
        productId: product.idProducto,
        productName: product.producto,
        variantId: variant.idVariante,
        sku: variant.sku ?? sku,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido importando ítem externo';
      result.errors.push(`${item.source}:${item.externalId} (${item.name}): ${message}`);
    }
  }

  if (result.variantsCreated === 0 && result.errors.length > 0) {
    throw new HttpError(
      422,
      `No se pudo importar ningún ítem externo: ${result.errors[0]}`,
      'EXTERNAL_IMPORT_FAILED'
    );
  }

  return result;
}

export async function listMetaPending(query: ExternalMetaPendingQuery) {
  return listPendingMetaItems(query.limit, query.search);
}

export type ExternalSource = 'meta' | 'contifico';

export interface ExternalPendingItem {
  source: ExternalSource;
  sources: ExternalSource[];
  externalId: string;
  sku: string | null;
  metaRetailerId: string | null;
  contificoId: string | null;
  contificoSku: string | null;
  name: string;
  price: number | null;
  imageUrl: string | null;
  url: string | null;
  stock: number | null;
  category: string | null;
  barcode: string | null;
  availability: string | null;
}

export interface ExternalPendingResult {
  items: ExternalPendingItem[];
  counts: { meta: number; contifico: number; total: number };
  warnings: string[];
}

function parseMetaPrice(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function mergePendingItems(
  meta: ExternalPendingItem[],
  contifico: ExternalPendingItem[]
): ExternalPendingItem[] {
  const groups = new Map<string, ExternalPendingItem>();

  const add = (item: ExternalPendingItem) => {
    const groupKey = normalize(item.name);
    const existing = groups.get(groupKey);
    if (!existing) {
      groups.set(groupKey, { ...item, sources: [...item.sources] });
      return;
    }
    if (!existing.sources.includes(item.source)) {
      existing.sources.push(item.source);
    }
    if (item.source === 'meta') {
      existing.metaRetailerId = item.metaRetailerId ?? item.externalId;
    } else {
      existing.contificoId = item.contificoId ?? item.externalId;
      existing.contificoSku = item.contificoSku ?? item.sku;
    }
    existing.sku ??= item.sku;
    existing.price ??= item.price;
    existing.imageUrl ??= item.imageUrl;
    existing.url ??= item.url;
    existing.stock ??= item.stock;
    existing.category ??= item.category;
    existing.barcode ??= item.barcode;
    existing.availability ??= item.availability;
  };

  meta.forEach(add);
  contifico.forEach(add);
  return Array.from(groups.values());
}

async function loadPendingContificoItems(): Promise<ExternalPendingItem[]> {
  const prisma = getPrisma();
  const [products, categories, variants] = await Promise.all([
    fetchAllContificoProducts(),
    fetchContificoCategories(),
    prisma.productoVariante.findMany({
      select: {
        contificoId: true,
        contificoSku: true,
        sku: true,
        color: true,
        producto: { select: { producto: true } },
      },
    }),
  ]);

  const categoryNames = new Map(
    categories.map((category) => [category.id, category.nombre])
  );
  const mappedIds = new Set(
    variants
      .map((variant) => normalize(variant.contificoId))
      .filter((value): value is string => Boolean(value))
  );
  const mappedSkus = new Set(
    variants
      .map((variant) => normalize(variant.contificoSku ?? variant.sku))
      .filter((value): value is string => Boolean(value))
  );
  const existingNames = new Set<string>();
  for (const variant of variants) {
    const productName = variant.producto?.producto?.trim();
    if (!productName) {
      continue;
    }
    existingNames.add(normalize(productName));
    const color = variant.color?.trim();
    if (color && !/^est[aá]ndar$/i.test(color)) {
      existingNames.add(normalize(`${productName} ${color}`));
    }
  }

  return products
    .map((product) =>
      mapContificoProduct(
        product,
        product.categoria_id
          ? categoryNames.get(product.categoria_id) ?? null
          : null
      )
    )
    .filter((product) => product.isActive)
    .filter((product) => {
      const id = normalize(product.externalId);
      const sku = normalize(product.sku);
      return (
        !mappedIds.has(id) &&
        !mappedSkus.has(sku) &&
        !existingNames.has(normalize(product.name))
      );
    })
    .map((product) => ({
      source: 'contifico' as const,
      sources: ['contifico' as const],
      externalId: product.externalId,
      sku: product.sku,
      metaRetailerId: null,
      contificoId: product.externalId,
      contificoSku: product.sku,
      name: product.name,
      price: product.price,
      imageUrl: product.thumbnailUrl,
      url: product.sourceUrl,
      stock: product.stock,
      category: product.category,
      barcode: product.barcode,
      availability: 'in stock',
    }));
}

export async function listPendingExternalItems(
  query: ExternalPendingQuery
): Promise<ExternalPendingResult> {
  const warnings: string[] = [];

  const [meta, contifico] = await Promise.all([
    listPendingMetaItems(500).catch((error) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      warnings.push(`No se pudieron consultar los pendientes de Meta: ${message}`);
      logger.warn({ err: error }, 'No se pudieron cargar los pendientes de Meta');
      return { items: [], total: 0 };
    }),
    loadPendingContificoItems().catch((error) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      warnings.push(`No se pudieron consultar los pendientes de Contifico: ${message}`);
      logger.warn({ err: error }, 'No se pudieron cargar los pendientes de Contifico');
      return [] as ExternalPendingItem[];
    }),
  ]);

  const metaItems: ExternalPendingItem[] = meta.items.map((item) => ({
    source: 'meta',
    sources: ['meta'],
    externalId: item.retailerId,
    sku: null,
    metaRetailerId: item.retailerId,
    contificoId: null,
    contificoSku: null,
    name: item.name || item.retailerId,
    price: parseMetaPrice(item.price),
    imageUrl: item.imageUrl,
    url: item.url,
    stock: null,
    category: null,
    barcode: null,
    availability: item.availability,
  }));

  const merged = mergePendingItems(metaItems, contifico);
  const term = normalize(query.search);
  const filtered = merged
    .filter((item) => {
      if (query.source !== 'all' && !item.sources.includes(query.source)) {
        return false;
      }
      if (!term) {
        return true;
      }
      return [
        item.name,
        item.sku,
        item.externalId,
        item.metaRetailerId,
        item.contificoId,
        item.contificoSku,
        item.category,
      ].some((value) => normalize(value).includes(term));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, query.limit);

  return {
    items: filtered,
    counts: {
      meta: meta.total,
      contifico: contifico.length,
      total: merged.length,
    },
    warnings,
  };
}

export async function listExternalLinks() {
  const variants = await getPrisma().productoVariante.findMany({
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      metaRetailerId: true,
      contificoId: true,
      contificoSku: true,
      producto: { select: { producto: true } },
    },
    orderBy: { idVariante: 'asc' },
  });

  return { items: variants };
}
