import { getPrisma } from '../../config/prisma';

export const CANONICAL_TAXONOMY = {
  Sillas: [
    'Sillas Tapizadas',
    'Sillas de Plastico',
    'Sillas de Oficina',
    'Sillas Bistro y exterior',
  ],
  Taburetes: ['Taburetes'],
  Bases: ['Bases'],
  Mesas: ['Mesas'],
  Otros: ['Otros'],
} as const;

export const VISIBLE_TAXONOMY = {
  Sillas: CANONICAL_TAXONOMY.Sillas,
  Taburetes: CANONICAL_TAXONOMY.Taburetes,
  Bases: CANONICAL_TAXONOMY.Bases,
  Mesas: CANONICAL_TAXONOMY.Mesas,
} as const;

export type CanonicalCategory = keyof typeof CANONICAL_TAXONOMY;
export type CanonicalSubcategory =
  (typeof CANONICAL_TAXONOMY)[CanonicalCategory][number];
export type VisibleCategory = keyof typeof VISIBLE_TAXONOMY;

export const VISIBLE_CATEGORY_NAMES = Object.keys(
  VISIBLE_TAXONOMY
) as VisibleCategory[];

export const SYSTEM_FALLBACK_CATEGORY = 'Otros' as const;
export const SYSTEM_FALLBACK_SUBCATEGORY = 'Otros' as const;

export interface TaxonomyInput {
  categoryName?: string | null;
  subcategoryName?: string | null;
  productName?: string | null;
}

export interface CanonicalTaxonomy {
  category: CanonicalCategory;
  subcategory: CanonicalSubcategory;
}

export interface ResolvedTaxonomy extends CanonicalTaxonomy {
  categoryId: number;
  subcategoryId: number;
}

export interface TaxonomySelection {
  categoryId: number;
  subcategoryId: number;
}

const TARGETS: Record<string, CanonicalTaxonomy> = {
  sillasTapizadas: { category: 'Sillas', subcategory: 'Sillas Tapizadas' },
  sillasPlastico: { category: 'Sillas', subcategory: 'Sillas de Plastico' },
  sillasOficina: { category: 'Sillas', subcategory: 'Sillas de Oficina' },
  sillasBistro: { category: 'Sillas', subcategory: 'Sillas Bistro y exterior' },
  taburetes: { category: 'Taburetes', subcategory: 'Taburetes' },
  bases: { category: 'Bases', subcategory: 'Bases' },
  mesas: { category: 'Mesas', subcategory: 'Mesas' },
  otros: { category: 'Otros', subcategory: 'Otros' },
};

const ALL_CATEGORY_NAMES = Object.keys(
  CANONICAL_TAXONOMY
) as CanonicalCategory[];

function canonicalCategory(
  value: string | null | undefined
): CanonicalCategory | null {
  const normalized = normalizeTaxonomyText(value);
  return (
    ALL_CATEGORY_NAMES.find(
      (category) => normalizeTaxonomyText(category) === normalized
    ) ?? null
  );
}

function canonicalSubcategory(
  category: CanonicalCategory,
  value: string | null | undefined
): CanonicalSubcategory | null {
  const normalized = normalizeTaxonomyText(value);
  return (
    CANONICAL_TAXONOMY[category].find(
      (subcategory) => normalizeTaxonomyText(subcategory) === normalized
    ) ?? null
  );
}

const ACCESSORY_PATTERN =
  /REPUESTO|KIT ADAPTADOR|LAVACABELLO|LAVACABEZAS|CALENTADOR|CAMILLA|ARO LUZ|ASISTENTE|PULIDOR|SECADOR|VAPORIZADOR|LETRERO|PUPO|ESPEJO|EXTENSION|BIBLIOTECA|LIBRERO|ESTANTE|BASURERO|ZAPATO/;
const MESA_PATTERN = /MESA|ESCRITORIO|TABLERO|CREDENZA|COUNTER/;
const SILLA_PATTERN = /SILLA|SILLON|ARTURITO/;
const OTROS_PATTERN = /SOFA|TANDEM|BOOTH|COWORKING|MUEBLE|BANCO|TACHO/;
const SILLA_OFICINA_PATTERN = /OFICINA|GERENCIAL|GAMER|CAJERA|ESPERA|TADEN|ARTURITO/;
const SILLA_PLASTICO_PATTERN =
  /PLASTIC|PLASTICO|POLIPROPILENO|EAMES|PVC|ADRIANA|BRADLEY|ESTELA|SALOME/;
const SILLA_BISTRO_PATTERN =
  /BISTRO|EXTERIOR|RATTAN|TOLIX|METAL|EVENTO|TIFFANY|TIFANNY|NAPOLEON|OMEGA|CROSSBACK|LOUIS|VENDETTA|ACRILIC|ACRYLIC|GHOST|MAUI|MONACO/;
const SILLA_TAPIZADA_PATTERN = /TAPIZAD|BARBERSHOP|PELUQUERIA|SILLON/;

export function normalizeTaxonomyText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function categoryFromPrefix(name: string): CanonicalCategory | null {
  if (name.startsWith('TABURETE')) {
    return 'Taburetes';
  }
  if (name.startsWith('BASE')) {
    return 'Bases';
  }
  if (/^(MESA|ESCRITORIO|TABLERO|CREDENZA|COUNTER)/.test(name)) {
    return 'Mesas';
  }
  if (/^(SILLA|SILLON|ARTURITO)/.test(name)) {
    return 'Sillas';
  }
  if (/^(SOFA|TANDEM|BOOTH|COWORKING|MUEBLE|BANCO|TACHO)/.test(name)) {
    return 'Otros';
  }
  return null;
}

function strongCategoryFromName(name: string): CanonicalCategory | null {
  if (ACCESSORY_PATTERN.test(name)) {
    return 'Otros';
  }
  const prefix = categoryFromPrefix(name);
  if (prefix) {
    return prefix;
  }
  if (name.includes('TABURETE')) {
    return 'Taburetes';
  }
  if (MESA_PATTERN.test(name)) {
    return 'Mesas';
  }
  if (SILLA_PATTERN.test(name)) {
    return 'Sillas';
  }
  if (/\bBASE\b/.test(name)) {
    return 'Bases';
  }
  if (OTROS_PATTERN.test(name)) {
    return 'Otros';
  }
  return null;
}

function sillaSubcategory(
  name: string,
  currentCategoryName: string | null | undefined
): CanonicalSubcategory {
  if (SILLA_OFICINA_PATTERN.test(name)) {
    return 'Sillas de Oficina';
  }
  if (SILLA_PLASTICO_PATTERN.test(name)) {
    return 'Sillas de Plastico';
  }
  if (SILLA_BISTRO_PATTERN.test(name)) {
    return 'Sillas Bistro y exterior';
  }
  if (SILLA_TAPIZADA_PATTERN.test(name)) {
    return 'Sillas Tapizadas';
  }

  const current = normalizeTaxonomyText(currentCategoryName);
  if (current === 'SILLA PLASTICA') {
    return 'Sillas de Plastico';
  }
  if (current === 'SILLA OFICINA' || current === 'SILLA CAJERA') {
    return 'Sillas de Oficina';
  }
  if (
    current === 'SILLA BISTRO' ||
    current === 'SILLA METALICA' ||
    current === 'SILLA RATTAN'
  ) {
    return 'Sillas Bistro y exterior';
  }
  return 'Sillas Tapizadas';
}

function targetForCategory(
  category: CanonicalCategory,
  name: string,
  currentCategoryName?: string | null
): CanonicalTaxonomy {
  if (category === 'Sillas') {
    return {
      category,
      subcategory: sillaSubcategory(name, currentCategoryName),
    };
  }
  if (category === 'Taburetes') {
    return TARGETS.taburetes;
  }
  if (category === 'Bases') {
    return TARGETS.bases;
  }
  if (category === 'Mesas') {
    return TARGETS.mesas;
  }
  return TARGETS.otros;
}

function classifyByName(name: string): CanonicalTaxonomy | null {
  const category = strongCategoryFromName(name);
  if (!category) {
    return null;
  }
  return targetForCategory(category, name);
}

function knownCategoryTarget(
  normalizedCategory: string,
  name: string
): CanonicalTaxonomy | null {
  if (name.includes('TABURETE')) {
    return TARGETS.taburetes;
  }
  if (MESA_PATTERN.test(name)) {
    return TARGETS.mesas;
  }

  switch (normalizedCategory) {
    case 'SILLA PLASTICA':
      if (SILLA_PLASTICO_PATTERN.test(name) && !name.includes('CROSSBACK')) {
        return TARGETS.sillasPlastico;
      }
      if (SILLA_BISTRO_PATTERN.test(name)) {
        return TARGETS.sillasBistro;
      }
      return TARGETS.sillasPlastico;
    case 'SILLA OFICINA':
      return TARGETS.sillasOficina;
    case 'SILLA TAPIZADA':
      return TARGETS.sillasTapizadas;
    case 'SILLA BISTRO':
    case 'SILLA METALICA':
    case 'SILLA RATTAN':
      return TARGETS.sillasBistro;
    case 'SILLA CAJERA':
      return TARGETS.sillasOficina;
    case 'SILLA PHAMTOM':
    case 'SILLA FABIOLA II':
    case 'SILLA AAAAA':
    case 'SILLON MARYLIN':
    case 'SILLON BRITANY BLANCO':
    case 'OSLO BEIGE':
    case 'BRUSELAS':
    case 'KIKIRIQUI':
      return TARGETS.sillasTapizadas;
    case 'TABURETE METALICO':
    case 'TABURETE PLASTICO':
    case 'TABURETE TAPIZADO':
    case 'TABURETE BISTRO':
      return TARGETS.taburetes;
    case 'BASES METALICAS':
      return TARGETS.bases;
    case 'PELUQUERIA':
      if (SILLA_PATTERN.test(name)) {
        return TARGETS.sillasTapizadas;
      }
      return TARGETS.otros;
    case 'REPUESTOS':
      return TARGETS.otros;
    case 'PRODUCCION':
      if (MESA_PATTERN.test(name) || name.includes('MICAELA')) {
        return TARGETS.mesas;
      }
      return TARGETS.otros;
    case 'TABLERO':
      return TARGETS.mesas;
    case 'MUEBLES':
    case 'BIBLIOTECA LIBRERO ESTANTE':
    case 'BASURERO INDUSTRIAL':
    case 'ZAPATOS VARIOS':
      return TARGETS.otros;
    default:
      return null;
  }
}

export function classifyTaxonomy(input: TaxonomyInput): CanonicalTaxonomy {
  const currentCategory = canonicalCategory(input.categoryName);
  const currentSubcategory =
    currentCategory === null
      ? null
      : canonicalSubcategory(currentCategory, input.subcategoryName);
  const name = normalizeTaxonomyText(input.productName);
  const strongCategory = strongCategoryFromName(name);

  if (currentCategory && currentSubcategory) {
    if (!strongCategory || strongCategory === currentCategory) {
      return { category: currentCategory, subcategory: currentSubcategory };
    }
    return (
      classifyByName(name) ??
      targetForCategory(currentCategory, name, input.categoryName)
    );
  }

  if (currentCategory) {
    if (strongCategory && strongCategory !== currentCategory) {
      return (
        classifyByName(name) ??
        targetForCategory(currentCategory, name, input.categoryName)
      );
    }
    return targetForCategory(currentCategory, name, input.categoryName);
  }

  return (
    knownCategoryTarget(normalizeTaxonomyText(input.categoryName), name) ??
    classifyByName(name) ??
    TARGETS.otros
  );
}

interface EnsureTaxonomyOptions {
  isSystem?: boolean;
  sortOrder?: number;
}

async function ensureCategory(
  name: CanonicalCategory,
  options: EnsureTaxonomyOptions = {}
): Promise<number> {
  const prisma = getPrisma();
  const existing = await prisma.categoria.findFirst({
    where: { nombre: { equals: name, mode: 'insensitive' } },
    select: { id: true, isSystem: true },
  });
  if (existing) {
    if (options.isSystem && !existing.isSystem) {
      await prisma.categoria.update({
        where: { id: existing.id },
        data: {
          isSystem: true,
          isActive: true,
          ...(options.sortOrder !== undefined
            ? { sortOrder: options.sortOrder }
            : {}),
        },
      });
    }
    return existing.id;
  }
  const created = await prisma.categoria.create({
    data: {
      nombre: name,
      isSystem: options.isSystem ?? false,
      isActive: true,
      sortOrder: options.sortOrder ?? 0,
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureSubcategory(
  categoryId: number,
  name: CanonicalSubcategory,
  options: EnsureTaxonomyOptions = {}
): Promise<number> {
  const prisma = getPrisma();
  const existing = await prisma.subcategoria.findFirst({
    where: {
      idCategoria: categoryId,
      nombre: { equals: name, mode: 'insensitive' },
    },
    select: { id: true, isSystem: true },
  });
  if (existing) {
    if (options.isSystem && !existing.isSystem) {
      await prisma.subcategoria.update({
        where: { id: existing.id },
        data: {
          isSystem: true,
          isActive: true,
          ...(options.sortOrder !== undefined
            ? { sortOrder: options.sortOrder }
            : {}),
        },
      });
    }
    return existing.id;
  }
  const created = await prisma.subcategoria.create({
    data: {
      idCategoria: categoryId,
      nombre: name,
      isSystem: options.isSystem ?? false,
      isActive: true,
      sortOrder: options.sortOrder ?? 0,
    },
    select: { id: true },
  });
  return created.id;
}

export function taxonomyKey(
  category: CanonicalCategory,
  subcategory: CanonicalSubcategory
): string {
  return `${normalizeTaxonomyText(category)}|${normalizeTaxonomyText(subcategory)}`;
}

function canonicalOrder(target: CanonicalTaxonomy): {
  category: number;
  subcategory: number;
} {
  if (target.category === SYSTEM_FALLBACK_CATEGORY) {
    return { category: VISIBLE_CATEGORY_NAMES.length + 1, subcategory: 1 };
  }
  const categoryIndex = VISIBLE_CATEGORY_NAMES.indexOf(target.category);
  const subcategories = VISIBLE_TAXONOMY[target.category] as readonly string[];
  return {
    category: categoryIndex + 1,
    subcategory: subcategories.indexOf(target.subcategory) + 1,
  };
}

export async function resolveTaxonomySelection(input: {
  categoryName: string;
  subcategoryName?: string | null;
}): Promise<TaxonomySelection> {
  const prisma = getPrisma();
  const categoryName = input.categoryName.trim();
  const subcategoryName = input.subcategoryName?.trim() || 'General';

  let category = await prisma.categoria.findFirst({
    where: { nombre: { equals: categoryName, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!category) {
    const aggregate = await prisma.categoria.aggregate({
      _max: { sortOrder: true },
    });
    category = await prisma.categoria.create({
      data: {
        nombre: categoryName,
        isActive: true,
        isSystem: false,
        sortOrder: (aggregate._max.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });
  }

  let subcategory = await prisma.subcategoria.findFirst({
    where: {
      idCategoria: category.id,
      nombre: { equals: subcategoryName, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (!subcategory) {
    const aggregate = await prisma.subcategoria.aggregate({
      where: { idCategoria: category.id },
      _max: { sortOrder: true },
    });
    subcategory = await prisma.subcategoria.create({
      data: {
        idCategoria: category.id,
        nombre: subcategoryName,
        isActive: true,
        isSystem: false,
        sortOrder: (aggregate._max.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });
  }

  return {
    categoryId: category.id,
    subcategoryId: subcategory.id,
  };
}

export async function ensureCanonicalTaxonomy(): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const [index, category] of VISIBLE_CATEGORY_NAMES.entries()) {
    const categoryId = await ensureCategory(category, {
      isSystem: false,
      sortOrder: index + 1,
    });
    for (const [subIndex, subcategory] of VISIBLE_TAXONOMY[
      category
    ].entries()) {
      const subcategoryId = await ensureSubcategory(categoryId, subcategory, {
        isSystem: false,
        sortOrder: subIndex + 1,
      });
      ids.set(taxonomyKey(category, subcategory), subcategoryId);
    }
  }

  const systemCategoryId = await ensureCategory(SYSTEM_FALLBACK_CATEGORY, {
    isSystem: true,
    sortOrder: VISIBLE_CATEGORY_NAMES.length + 1,
  });
  const systemSubcategoryId = await ensureSubcategory(
    systemCategoryId,
    SYSTEM_FALLBACK_SUBCATEGORY,
    { isSystem: true, sortOrder: 1 }
  );
  ids.set(
    taxonomyKey(SYSTEM_FALLBACK_CATEGORY, SYSTEM_FALLBACK_SUBCATEGORY),
    systemSubcategoryId
  );
  return ids;
}

export async function resolveCanonicalTaxonomy(
  input: TaxonomyInput
): Promise<ResolvedTaxonomy> {
  const target = classifyTaxonomy(input);
  const order = canonicalOrder(target);
  const isSystem = target.category === SYSTEM_FALLBACK_CATEGORY;
  const categoryId = await ensureCategory(target.category, {
    isSystem,
    sortOrder: order.category,
  });
  const subcategoryId = await ensureSubcategory(
    categoryId,
    target.subcategory,
    {
      isSystem,
      sortOrder: order.subcategory,
    }
  );
  return {
    ...target,
    categoryId,
    subcategoryId,
  };
}
