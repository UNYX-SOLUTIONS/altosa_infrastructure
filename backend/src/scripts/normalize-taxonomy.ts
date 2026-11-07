import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';
import {
  CANONICAL_TAXONOMY,
  classifyTaxonomy,
  ensureCanonicalTaxonomy,
  loadCanonicalTaxonomyIds,
  normalizeTaxonomyText,
  taxonomyKey,
  type CanonicalCategory,
} from '../modules/catalog/taxonomy';

interface ReportRow {
  productId: number;
  productName: string;
  currentCategory: string;
  currentSubcategory: string;
  targetCategory: string;
  targetSubcategory: string;
  action: 'keep' | 'move';
}

function readOption(name: string): string | null {
  const index = process.argv.lastIndexOf(`--${name}`);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function writeCsv(path: string, rows: ReportRow[]): Promise<void> {
  const headers = [
    'idProducto',
    'producto',
    'categoriaActual',
    'subcategoriaActual',
    'categoriaDestino',
    'subcategoriaDestino',
    'accion',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      [
        row.productId,
        row.productName,
        row.currentCategory,
        row.currentSubcategory,
        row.targetCategory,
        row.targetSubcategory,
        row.action,
      ]
        .map((value) => csvEscape(String(value)))
        .join(',')
    ),
  ];
  const absolutePath = resolve(process.cwd(), path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${lines.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const reportPath = readOption('report') ?? 'data/taxonomy-normalization.csv';
  const summaryPath = readOption('summary');
  const prisma = getPrisma();

  const existingCanonicalIds = apply
    ? await loadCanonicalTaxonomyIds()
    : null;
  const canonicalSubcategoryIds = apply
    ? await ensureCanonicalTaxonomy()
    : (existingCanonicalIds ?? new Map<string, number>());
  const canonicalBefore = existingCanonicalIds ?? canonicalSubcategoryIds;
  const canonicalSubcategoryIdSet = new Set(canonicalSubcategoryIds.values());
  const canonicalToCreate = Object.entries(CANONICAL_TAXONOMY).flatMap(
    ([categoryName, subcategories]) =>
      subcategories
        .map((subcategory) => ({
          category: categoryName,
          subcategory,
          key: taxonomyKey(
            categoryName as CanonicalCategory,
            subcategory
          ),
        }))
        .filter((item) => !canonicalBefore.has(item.key))
        .map(({ category, subcategory }) => ({ category, subcategory }))
  );
  const canonicalCategoryNames = new Set(
    (Object.keys(CANONICAL_TAXONOMY) as CanonicalCategory[]).map(
      (category) => normalizeTaxonomyText(category)
    )
  );

  const products = await prisma.producto.findMany({
    select: {
      idProducto: true,
      producto: true,
      subcategoria: {
        select: {
          id: true,
          nombre: true,
          categoria: { select: { nombre: true } },
        },
      },
    },
    orderBy: { idProducto: 'asc' },
  });

  const rows: ReportRow[] = [];
  const updates: Array<{ idProducto: number; idSubCategoria: number }> = [];
  const missingTargets = new Set<string>();
  const currentSubcategoryIdByProduct = new Map<number, number>();

  for (const product of products) {
    currentSubcategoryIdByProduct.set(
      product.idProducto,
      product.subcategoria.id
    );
    const currentCategory = product.subcategoria.categoria.nombre;
    const currentSubcategory = product.subcategoria.nombre;
    const target = classifyTaxonomy({
      categoryName: currentCategory,
      subcategoryName: currentSubcategory,
      productName: product.producto,
    });
    const targetKey = taxonomyKey(target.category, target.subcategory);
    const targetId = canonicalSubcategoryIds.get(targetKey);
    const currentPairMatches =
      normalizeTaxonomyText(currentCategory) ===
        normalizeTaxonomyText(target.category) &&
      normalizeTaxonomyText(currentSubcategory) ===
        normalizeTaxonomyText(target.subcategory);

    if (apply && !targetId) {
      missingTargets.add(targetKey);
      continue;
    }

    const action = apply
      ? product.subcategoria.id === targetId
        ? 'keep'
        : 'move'
      : currentPairMatches
        ? 'keep'
        : 'move';
    rows.push({
      productId: product.idProducto,
      productName: product.producto,
      currentCategory,
      currentSubcategory,
      targetCategory: target.category,
      targetSubcategory: target.subcategory,
      action,
    });
    if (action === 'move' && targetId) {
      updates.push({
        idProducto: product.idProducto,
        idSubCategoria: targetId,
      });
    }
  }

  if (missingTargets.size > 0) {
    throw new Error(
      `No se pudieron resolver subcategorías canónicas: ${[...missingTargets].join(', ')}`
    );
  }

  if (apply && updates.length > 0) {
    const chunkSize = 100;
    for (let index = 0; index < updates.length; index += chunkSize) {
      const chunk = updates.slice(index, index + chunkSize);
      const updatedAt = new Date();
      await prisma.$transaction(
        chunk.map((update) =>
          prisma.producto.update({
            where: { idProducto: update.idProducto },
            data: {
              idSubCategoria: update.idSubCategoria,
              updatedAt,
            },
          })
        )
      );
      process.stderr.write(
        `  actualizados ${Math.min(index + chunkSize, updates.length)}/${updates.length}\n`
      );
    }
  }

  const allSubcategories = await prisma.subcategoria.findMany({
    include: {
      categoria: { select: { id: true, nombre: true } },
      _count: { select: { productos: true } },
    },
    orderBy: { id: 'asc' },
  });

  const remainingProductsBySubcategory = new Map<number, number>();
  for (const subcategory of allSubcategories) {
    remainingProductsBySubcategory.set(
      subcategory.id,
      subcategory._count.productos
    );
  }
  if (!apply) {
    for (const row of rows) {
      if (row.action !== 'move') {
        continue;
      }
      const currentSubcategoryId = currentSubcategoryIdByProduct.get(
        row.productId
      );
      if (!currentSubcategoryId) {
        continue;
      }
      remainingProductsBySubcategory.set(
        currentSubcategoryId,
        (remainingProductsBySubcategory.get(currentSubcategoryId) ?? 0) - 1
      );
    }
  }

  const productCountFor = (subcategoryId: number, actualCount: number): number =>
    apply ? actualCount : (remainingProductsBySubcategory.get(subcategoryId) ?? 0);

  const nonCanonicalSubcategories = allSubcategories.filter(
    (subcategory) => !canonicalSubcategoryIdSet.has(subcategory.id)
  );
  const emptyNonCanonicalSubcategories = nonCanonicalSubcategories.filter(
    (subcategory) => productCountFor(subcategory.id, subcategory._count.productos) === 0
  );
  const blockedSubcategories = nonCanonicalSubcategories.filter(
    (subcategory) => productCountFor(subcategory.id, subcategory._count.productos) > 0
  );

  const subcategoryIdsToDelete = new Set(
    emptyNonCanonicalSubcategories.map((item) => item.id)
  );
  const remainingSubcategoriesByCategory = new Map<number, number>();
  for (const subcategory of allSubcategories) {
    if (subcategoryIdsToDelete.has(subcategory.id)) {
      continue;
    }
    const categoryId = subcategory.categoria.id;
    remainingSubcategoriesByCategory.set(
      categoryId,
      (remainingSubcategoriesByCategory.get(categoryId) ?? 0) + 1
    );
  }

  let deletedSubcategories = 0;
  if (apply && emptyNonCanonicalSubcategories.length > 0) {
    const result = await prisma.subcategoria.deleteMany({
      where: { id: { in: [...subcategoryIdsToDelete] } },
    });
    deletedSubcategories = result.count;
  }

  const allCategories = await prisma.categoria.findMany({
    orderBy: { id: 'asc' },
  });
  const nonCanonicalCategories = allCategories.filter(
    (category) => !canonicalCategoryNames.has(normalizeTaxonomyText(category.nombre))
  );
  const emptyNonCanonicalCategories = nonCanonicalCategories.filter(
    (category) => (remainingSubcategoriesByCategory.get(category.id) ?? 0) === 0
  );
  const blockedCategories = nonCanonicalCategories.filter(
    (category) => (remainingSubcategoriesByCategory.get(category.id) ?? 0) > 0
  );

  let deletedCategories = 0;
  if (apply && emptyNonCanonicalCategories.length > 0) {
    const result = await prisma.categoria.deleteMany({
      where: { id: { in: emptyNonCanonicalCategories.map((item) => item.id) } },
    });
    deletedCategories = result.count;
  }

  await writeCsv(reportPath, rows);

  const targetCounts = rows.reduce<Record<string, number>>((accumulator, row) => {
    const key = `${row.targetCategory} / ${row.targetSubcategory}`;
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});

  const productsToMove = rows.filter((row) => row.action === 'move').length;

  const summary = {
    checkedAt: new Date().toISOString(),
    apply,
    productsScanned: products.length,
    productsToMove,
    productsMoved: apply ? productsToMove : 0,
    targetCounts,
    canonicalToCreate,
    reportPath: resolve(process.cwd(), reportPath),
    subcategoriesToDelete: emptyNonCanonicalSubcategories.map((item) => ({
      id: item.id,
      categoria: item.categoria.nombre,
      nombre: item.nombre,
    })),
    subcategoriesDeleted: deletedSubcategories,
    blockedSubcategories: blockedSubcategories.map((item) => ({
      id: item.id,
      categoria: item.categoria.nombre,
      nombre: item.nombre,
      productos: productCountFor(item.id, item._count.productos),
    })),
    categoriesToDelete: emptyNonCanonicalCategories.map((item) => ({
      id: item.id,
      nombre: item.nombre,
    })),
    categoriesDeleted: deletedCategories,
    blockedCategories: blockedCategories.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      subcategoriasRestantes:
        remainingSubcategoriesByCategory.get(item.id) ?? 0,
    })),
    canonicalSubcategoryIds: Object.fromEntries(
      [...canonicalSubcategoryIds.entries()].map(([key, id]) => [key, id])
    ),
  };

  if (summaryPath) {
    const absoluteSummaryPath = resolve(process.cwd(), summaryPath);
    await mkdir(dirname(absoluteSummaryPath), { recursive: true });
    await writeFile(
      absoluteSummaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8'
    );
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log(
      'DRY-RUN: no se escribió nada en la base. Usa --apply para aplicar los cambios.'
    );
  }

  if (
    apply &&
    (blockedSubcategories.length > 0 || blockedCategories.length > 0)
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
