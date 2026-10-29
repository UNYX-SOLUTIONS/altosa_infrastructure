import { getPrisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import {
  buildFlatName,
  inferBaseName,
  inferVariantColor,
  normalizeLooseText,
} from '../../utils/product-naming';
import { resolveSyncEstados } from '../catalog/catalog-estados';
import {
  fetchAllContificoProducts,
  fetchContificoCategories,
} from './contifico-catalog';
import { mapContificoProduct, resolveContificoSku } from './contifico-mappers';
import type {
  ContificoCanonicalProduct,
  ContificoSyncCounters,
  ContificoSyncOptions,
} from './contifico-types';

function key(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function mergeSpecs(
  existing: string | null | undefined,
  incoming: Record<string, unknown>
): string | null {
  if (Object.keys(incoming).length === 0 && !existing) {
    return null;
  }

  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else {
        base = { especificaciones_originales: existing };
      }
    } catch {
      base = { especificaciones_originales: existing };
    }
  }

  return JSON.stringify({ ...base, ...incoming });
}

async function resolveTaxonomy(categoryName: string | null): Promise<number> {
  const prisma = getPrisma();
  const name = categoryName?.trim() || 'General';

  const categoria =
    (await prisma.categoria.findFirst({
      where: { nombre: { equals: name, mode: 'insensitive' } },
    })) ??
    (await prisma.categoria.create({
      data: { nombre: name, updatedAt: new Date() },
    }));

  const subcategoria =
    (await prisma.subcategoria.findFirst({
      where: {
        idCategoria: categoria.id,
        nombre: { equals: 'General', mode: 'insensitive' },
      },
    })) ??
    (await prisma.subcategoria.create({
      data: {
        idCategoria: categoria.id,
        nombre: 'General',
        updatedAt: new Date(),
      },
    }));

  return subcategoria.id;
}

async function resolveUniqueSku(base: string): Promise<string> {
  const prisma = getPrisma();
  const clean = base.trim().slice(0, 120) || `CONF-${Date.now()}`;
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

export async function syncContificoCatalog(
  options: ContificoSyncOptions = {}
): Promise<ContificoSyncCounters> {
  const startedAt = Date.now();
  const prisma = getPrisma();
  const dryRun = options.dryRun ?? false;
  const matchByName = options.matchByName ?? false;
  const createMissing = options.createMissing ?? false;
  const prune = (options.prune ?? false) && !options.onlySku;
  const onlySku = key(options.onlySku);
  const estados = await resolveSyncEstados();

  const [rawProducts, categories] = await Promise.all([
    fetchAllContificoProducts(),
    fetchContificoCategories(),
  ]);
  const categoryNames = new Map(
    categories.map((category) => [category.id, category.nombre])
  );

  const products = rawProducts
    .map((product) =>
      mapContificoProduct(
        product,
        product.categoria_id
          ? categoryNames.get(product.categoria_id) ?? null
          : null
      )
    )
    .filter((product) =>
      onlySku ? key(product.sku) === onlySku : true
    );

  const counters: ContificoSyncCounters = {
    source: 'contifico',
    dryRun,
    durationMs: 0,
    categoriesFetched: categories.length,
    products: {
      fetched: products.length,
      created: 0,
      updated: 0,
      ignored: 0,
      skipped: 0,
      pruned: 0,
    },
    variants: {
      created: 0,
      updated: 0,
      skipped: 0,
      deactivated: 0,
    },
  };

  const variants = await prisma.productoVariante.findMany({
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      isActive: true,
      contificoId: true,
      contificoSku: true,
      descripcion: true,
      imagenUrl: true,
      especificacionesAdicionales: true,
      producto: { select: { idProducto: true, producto: true, isActive: true } },
    },
  });
  type VariantRow = (typeof variants)[number];

  const byContificoId = new Map<string, VariantRow>();
  const byContificoSku = new Map<string, VariantRow>();
  const bySku = new Map<string, VariantRow>();
  const byFlatName = new Map<string, VariantRow>();

  for (const variant of variants) {
    if (variant.contificoId) {
      byContificoId.set(key(variant.contificoId), variant);
    }
    if (variant.contificoSku) {
      byContificoSku.set(key(variant.contificoSku), variant);
    }
    if (variant.sku) {
      bySku.set(key(variant.sku), variant);
    }
    const parentName = variant.producto.producto;
    byFlatName.set(
      normalizeLooseText(buildFlatName(parentName, variant.color)),
      variant
    );
    byFlatName.set(normalizeLooseText(parentName), variant);
  }

  const seenContificoIds = new Set<string>();
  const seenContificoSKus = new Set<string>();
  const touchedProductIds = new Set<number>();

  for (const product of products) {
    if (product.sku) {
      seenContificoSKus.add(key(product.sku));
    }
    seenContificoIds.add(key(product.externalId));

    const existing =
      byContificoId.get(key(product.externalId)) ??
      byContificoSku.get(key(product.sku)) ??
      bySku.get(key(product.sku)) ??
      (matchByName ? byFlatName.get(normalizeLooseText(product.name)) : null);

    if (existing) {
      counters.products.updated += 1;
      counters.variants.updated += 1;
      touchedProductIds.add(existing.idProducto);

      if (!dryRun) {
        const specs = mergeSpecs(existing.especificacionesAdicionales, {
          ...product.variants[0]?.especificaciones,
          stock: product.stock,
        });
        await prisma.productoVariante.update({
          where: { idVariante: existing.idVariante },
          data: {
            precioUsd: product.price,
            especificacionesAdicionales: specs,
            contificoId: product.externalId,
            contificoSku: product.sku,
            // Variante aprobada: no pisotear nombre/color/descripción/imagen
            // curados. Solo precio, stock, specs y mapeo.
            ...(existing.isActive
              ? {}
              : {
                  descripcion: product.description ?? existing.descripcion,
                  imagenUrl: existing.imagenUrl ?? product.thumbnailUrl,
                }),
          },
        });
      }
      continue;
    }

    if (!createMissing) {
      counters.products.ignored += 1;
      continue;
    }

    const baseName = inferBaseName(product.name);
    const inferredColor = inferVariantColor(product.name, baseName);
    const variantColor =
      inferredColor.trim().toLowerCase() === product.name.trim().toLowerCase()
        ? 'Estándar'
        : inferredColor;

    counters.products.created += 1;
    counters.variants.created += 1;

    if (dryRun) {
      continue;
    }

    let parent = await prisma.producto.findFirst({
      where: { producto: { equals: baseName, mode: 'insensitive' } },
      select: { idProducto: true, producto: true },
    });
    if (!parent) {
      const idSubCategoria = await resolveTaxonomy(product.category);
      parent = await prisma.producto.create({
        data: {
          idSubCategoria,
          producto: baseName,
          descripcion: product.description ?? product.name,
          estadoId: estados.inactiveId,
          isActive: false,
        },
        select: { idProducto: true, producto: true },
      });
    }

    const sku = await resolveUniqueSku(product.sku);
    const createdVariant = await prisma.productoVariante.create({
      data: {
        idProducto: parent.idProducto,
        sku,
        color: variantColor,
        descripcion: product.description,
        precioUsd: product.price,
        imagenUrl: product.thumbnailUrl,
        estadoId: estados.inactiveId,
        // Ingesta/sync: entra inactivo para aprobación humana en el ERP.
        isActive: false,
        contificoId: product.externalId,
        contificoSku: product.sku,
        especificacionesAdicionales: mergeSpecs(null, {
          ...product.variants[0]?.especificaciones,
          stock: product.stock,
        }),
      },
      select: {
        idVariante: true,
        idProducto: true,
        sku: true,
        color: true,
        isActive: true,
        contificoId: true,
        contificoSku: true,
        descripcion: true,
        imagenUrl: true,
        especificacionesAdicionales: true,
        producto: { select: { idProducto: true, producto: true, isActive: true } },
      },
    });

    byContificoId.set(key(createdVariant.contificoId), createdVariant);
    byContificoSku.set(key(createdVariant.contificoSku), createdVariant);
    if (createdVariant.sku) {
      bySku.set(key(createdVariant.sku), createdVariant);
    }
    byFlatName.set(
      normalizeLooseText(buildFlatName(parent.producto, createdVariant.color)),
      createdVariant
    );
    byFlatName.set(normalizeLooseText(parent.producto), createdVariant);
  }

  if (prune) {
    const stale = variants.filter((variant) => {
      const contificoId = key(variant.contificoId);
      const contificoSku = key(variant.contificoSku ?? variant.sku);
      if (!contificoId && !contificoSku) {
        return false;
      }
      return (
        (!contificoId || !seenContificoIds.has(contificoId)) &&
        (!contificoSku || !seenContificoSKus.has(contificoSku))
      );
    });

    counters.prunedSkuSample = stale
      .map((variant) => variant.sku)
      .filter((sku): sku is string => Boolean(sku))
      .slice(0, 20);

    for (const variant of stale) {
      if (variant.isActive) {
        counters.variants.deactivated += 1;
      }
      if (dryRun) {
        continue;
      }
      await prisma.productoVariante.update({
        where: { idVariante: variant.idVariante },
        data: { isActive: false, estadoId: estados.inactiveId },
      });
    }

    const staleProductIds = Array.from(
      new Set(stale.map((variant) => variant.idProducto))
    );
    for (const productId of staleProductIds) {
      const activeVariants = await prisma.productoVariante.count({
        where: { idProducto: productId, isActive: true },
      });
      if (activeVariants > 0) {
        continue;
      }
      const product = await prisma.producto.findUnique({
        where: { idProducto: productId },
        select: { isActive: true },
      });
      if (!product?.isActive) {
        continue;
      }
      counters.products.pruned += 1;
      if (!dryRun) {
        await prisma.producto.update({
          where: { idProducto: productId },
          data: { isActive: false, estadoId: estados.inactiveId },
        });
      }
    }
  }

  counters.durationMs = Date.now() - startedAt;
  logger.info(counters, 'Sync Contifico -> Altosa completado');
  return counters;
}
