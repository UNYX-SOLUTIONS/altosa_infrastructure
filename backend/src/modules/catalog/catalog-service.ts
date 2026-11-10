import type { Prisma } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { getPrisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';
import { buildFlatName } from '../../utils/product-naming';
import { findMetaCatalogItem } from '../meta/meta-client';
import {
  publishVariantById,
  publishVariantToMeta,
  updateVariantInMeta,
} from '../meta/meta-service';
import { resolveSyncEstados } from './catalog-estados';
import {
  normalizeTaxonomyText,
  resolveCanonicalTaxonomy,
  resolveTaxonomySelection,
} from './taxonomy';
import {
  createContificoProductForVariant,
  updateContificoProductForVariant,
} from '../contifico/contifico-service';
import type {
  CategoryCreateBody,
  CategoryUpdateBody,
  CreateProductBody,
  DocumentsQuery,
  ProductsQuery,
  SimpleListQuery,
  SubcategoryCreateBody,
  SubcategoryUpdateBody,
  SyncProductBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantBody,
  WarrantyCreateBody,
  WarrantyListQuery,
  WarrantyUpdateBody,
} from './catalog-schema';

const ESTADO_ACTIVO = 1;
const ESTADO_INACTIVO = 2;
const ESTADO_ANULADO = 3;

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function parseKeywords(raw: string | null): string[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } catch {
    return null;
  }
}

function serializeKeywords(keywords: string[]): string {
  const unique = Array.from(
    new Set(
      keywords
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0)
    )
  );
  return JSON.stringify(unique);
}

function resolveEstadoFields(input: {
  estadoId?: number;
  isActive?: boolean;
}): { estadoId: number | undefined; isActive: boolean | undefined } {
  if (input.estadoId !== undefined) {
    return { estadoId: input.estadoId, isActive: input.estadoId === ESTADO_ACTIVO };
  }
  if (input.isActive !== undefined) {
    return {
      estadoId: input.isActive ? ESTADO_ACTIVO : ESTADO_INACTIVO,
      isActive: input.isActive,
    };
  }
  return { estadoId: undefined, isActive: undefined };
}

function resolveExternalVariantName(params: {
  existingName: string | null;
  oldProductName: string;
  newProductName: string;
  oldColor: string | null;
  newColor: string | null;
  inputName?: string | null;
}): string {
  const existing = (params.existingName ?? '').trim();
  const inputName = (params.inputName ?? '').trim();
  if (inputName && inputName !== existing) {
    return inputName;
  }

  const oldAutoName = buildFlatName(
    params.oldProductName,
    params.oldColor
  ).trim();
  if (!existing || existing === oldAutoName) {
    return buildFlatName(params.newProductName, params.newColor);
  }

  return existing;
}

function mapEstado(estado: { id: number; estado: string; permiteRag: boolean }) {
  return {
    id: estado.id,
    estado: estado.estado,
    permiteRag: estado.permiteRag,
  };
}

function mapKommoTemplate(template: {
  id: string;
  kommoId: number;
  name: string;
  type: string;
  content: string | null;
  isActive: boolean;
} | null) {
  if (!template) {
    return null;
  }
  return {
    id: template.id,
    kommoId: template.kommoId,
    name: template.name,
    type: template.type,
    content: template.content,
    isActive: template.isActive,
  };
}

async function ensureKommoTemplateExists(id: string) {
  const prisma = getPrisma();
  const template = await prisma.kommoTemplate.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!template) {
    throw new HttpError(
      StatusCodes.UNPROCESSABLE_ENTITY,
      'Plantilla de Kommo no encontrada.',
      'KOMMO_TEMPLATE_NOT_FOUND'
    );
  }
}

function mapGarantia(garantia: {
  idGarantia: number;
  garantiaMeses: number | null;
  garantiaEspecial: string | null;
  observaciones: string | null;
} | null) {
  if (!garantia) {
    return null;
  }
  return {
    id: garantia.idGarantia,
    meses: garantia.garantiaMeses,
    especial: garantia.garantiaEspecial,
    observaciones: garantia.observaciones,
  };
}

function mapCatalogo(catalogo: {
  id: number;
  keyword: string | null;
  archivo: string | null;
  driveUrl: string | null;
  paginas: number | null;
} | null) {
  if (!catalogo) {
    return null;
  }
  return {
    id: catalogo.id,
    keyword: catalogo.keyword,
    archivo: catalogo.archivo,
    driveUrl: catalogo.driveUrl,
    paginas: catalogo.paginas,
  };
}

type VarianteConRelaciones = Prisma.ProductoVarianteGetPayload<{
  include: { garantia: true; catalogo: true; estado: true; kommoTemplate: true };
}>;

function mapVariante(variante: VarianteConRelaciones) {
  return {
    id: variante.idVariante,
    sku: variante.sku,
    metaRetailerId: variante.metaRetailerId,
    metaMappingLocked: variante.metaMappingLocked,
    contificoId: variante.contificoId,
    contificoSku: variante.contificoSku,
    contificoMappingLocked: variante.contificoMappingLocked,
    color: variante.color,
    nombre: variante.nombre,
    descripcion: variante.descripcion,
    precioUsd: toNumber(variante.precioUsd),
    porcentajeIva: variante.porcentajeIva,
    imagenUrl: variante.imagenUrl,
    urlProducto: variante.urlProducto,
    material: variante.material,
    tapizado: variante.tapizado,
    estructura: variante.estructura,
    usoRecomendado: variante.usoRecomendado,
    especificacionesAdicionales: variante.especificacionesAdicionales,
    apilable: variante.apilable,
    proteccionUv: variante.proteccionUv,
    resistenciaIntemperie: variante.resistenciaIntemperie,
    soporteLumbar: variante.soporteLumbar,
    brazos: variante.brazos,
    cabecera: variante.cabecera,
    mecanismo: variante.mecanismo,
    medidas: {
      anchoTotalCm: toNumber(variante.anchoTotalCm),
      profundidadAsientoCm: toNumber(variante.profundidadAsientoCm),
      alturaTotalCm: variante.alturaTotalCm,
      alturaAsientoCm: variante.alturaAsientoCm,
      anchoAsientoCm: toNumber(variante.anchoAsientoCm),
      pesoKg: toNumber(variante.pesoKg),
    },
    garantia: mapGarantia(variante.garantia),
    catalogo: mapCatalogo(variante.catalogo),
    estado: mapEstado(variante.estado),
    kommoTemplateId: variante.kommoTemplateId,
    kommoTemplate: mapKommoTemplate(variante.kommoTemplate),
    isActive: variante.isActive,
    updatedAt: variante.updatedAt,
  };
}

const VARIANT_RELATIONS = {
  garantia: true,
  catalogo: true,
  estado: true,
  kommoTemplate: true,
} as const;

export async function listProducts(query: ProductsQuery) {
  const prisma = getPrisma();

  const where: Prisma.ProductoWhereInput = {
    isActive: query.active,
    ...(query.subcategoryId ? { idSubCategoria: query.subcategoryId } : {}),
    ...(query.categoryId ? { subcategoria: { idCategoria: query.categoryId } } : {}),
    ...(query.search
      ? {
          OR: [
            { producto: { contains: query.search, mode: 'insensitive' } },
            { descripcion: { contains: query.search, mode: 'insensitive' } },
            { usoRecomendado: { contains: query.search, mode: 'insensitive' } },
            { palabrasClave: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.producto.count({ where }),
    prisma.producto.findMany({
      where,
      include: {
        estado: true,
        subcategoria: { include: { categoria: true } },
        variants: {
          ...(query.includeInactiveVariants
            ? {}
            : { where: { isActive: true } }),
          include: VARIANT_RELATIONS,
          orderBy: { idVariante: 'asc' },
        },
      },
      orderBy: { producto: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const items = rows.map((producto) => {
    const precios = producto.variants
      .map((variante) => toNumber(variante.precioUsd))
      .filter((precio): precio is number => precio !== null);

    return {
      id: producto.idProducto,
      nombre: producto.producto,
      descripcion: producto.descripcion,
      usoRecomendado: producto.usoRecomendado,
      keywords: parseKeywords(producto.palabrasClave),
      categoria: {
        id: producto.subcategoria.categoria.id,
        nombre: producto.subcategoria.categoria.nombre,
      },
      subcategoria: {
        id: producto.subcategoria.id,
        nombre: producto.subcategoria.nombre,
      },
      estado: mapEstado(producto.estado),
      isActive: producto.isActive,
      kommoTemplateId: producto.kommoTemplateId,
      updatedAt: producto.updatedAt,
      variantesCount: producto.variants.length,
      precioMin: precios.length > 0 ? Math.min(...precios) : null,
      precioMax: precios.length > 0 ? Math.max(...precios) : null,
      ...(query.withVariants ? { variantes: producto.variants.map(mapVariante) } : {}),
    };
  });

  return { items, total };
}

export async function getProductById(id: number) {
  const prisma = getPrisma();

  const producto = await prisma.producto.findUnique({
    where: { idProducto: id },
    include: {
      estado: true,
      subcategoria: { include: { categoria: true } },
      kommoTemplate: true,
      variants: {
        include: VARIANT_RELATIONS,
        orderBy: { idVariante: 'asc' },
      },
    },
  });

  if (!producto) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  return {
    id: producto.idProducto,
    nombre: producto.producto,
    descripcion: producto.descripcion,
    usoRecomendado: producto.usoRecomendado,
    keywords: parseKeywords(producto.palabrasClave),
    categoria: {
      id: producto.subcategoria.categoria.id,
      nombre: producto.subcategoria.categoria.nombre,
    },
    subcategoria: {
      id: producto.subcategoria.id,
      nombre: producto.subcategoria.nombre,
    },
    estado: mapEstado(producto.estado),
    isActive: producto.isActive,
    kommoTemplateId: producto.kommoTemplateId,
    kommoTemplate: mapKommoTemplate(producto.kommoTemplate),
    updatedAt: producto.updatedAt,
    variantes: producto.variants.map(mapVariante),
  };
}

export async function getProductByVariantSku(sku: string) {
  const prisma = getPrisma();

  const variante = await prisma.productoVariante.findFirst({
    where: { sku },
    include: {
      ...VARIANT_RELATIONS,
      producto: {
        include: {
          estado: true,
          subcategoria: { include: { categoria: true } },
          kommoTemplate: true,
        },
      },
    },
  });

  if (!variante) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      `Variante con SKU ${sku} no encontrada.`,
      'ALTOSA_VARIANT_NOT_FOUND'
    );
  }

  return {
    producto: {
      id: variante.producto.idProducto,
      nombre: variante.producto.producto,
      descripcion: variante.producto.descripcion,
      usoRecomendado: variante.producto.usoRecomendado,
      keywords: parseKeywords(variante.producto.palabrasClave),
      categoria: {
        id: variante.producto.subcategoria.categoria.id,
        nombre: variante.producto.subcategoria.categoria.nombre,
      },
      subcategoria: {
        id: variante.producto.subcategoria.id,
        nombre: variante.producto.subcategoria.nombre,
      },
      estado: mapEstado(variante.producto.estado),
      isActive: variante.producto.isActive,
      kommoTemplateId: variante.producto.kommoTemplateId,
      kommoTemplate: mapKommoTemplate(variante.producto.kommoTemplate),
    },
    variante: mapVariante(variante),
  };
}

function taxonomyDuplicate(message: string): HttpError {
  return new HttpError(StatusCodes.CONFLICT, message, 'TAXONOMY_DUPLICATE');
}

function taxonomyInUse(message: string): HttpError {
  return new HttpError(StatusCodes.CONFLICT, message, 'TAXONOMY_IN_USE');
}

function taxonomySystemProtected(): HttpError {
  return new HttpError(
    StatusCodes.CONFLICT,
    'La categoría o subcategoría de sistema no se puede modificar.',
    'TAXONOMY_SYSTEM_PROTECTED'
  );
}

function taxonomyNotFound(message: string): HttpError {
  return new HttpError(StatusCodes.NOT_FOUND, message, 'TAXONOMY_NOT_FOUND');
}

function rethrowTaxonomyPersistenceError(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  ) {
    throw taxonomyDuplicate('Ya existe una categoría o subcategoría con ese nombre.');
  }
  throw error;
}

async function assertCategoryNameAvailable(
  nombre: string,
  excludeId?: number
): Promise<void> {
  const prisma = getPrisma();
  const normalized = normalizeTaxonomyText(nombre);
  const categories = await prisma.categoria.findMany({
    select: { id: true, nombre: true },
  });
  const duplicate = categories.find(
    (category) =>
      category.id !== excludeId &&
      normalizeTaxonomyText(category.nombre) === normalized
  );
  if (duplicate) {
    throw taxonomyDuplicate(`Ya existe la categoría "${duplicate.nombre}".`);
  }
}

async function assertSubcategoryNameAvailable(
  idCategoria: number,
  nombre: string,
  excludeId?: number
): Promise<void> {
  const prisma = getPrisma();
  const normalized = normalizeTaxonomyText(nombre);
  const subcategories = await prisma.subcategoria.findMany({
    where: { idCategoria },
    select: { id: true, nombre: true },
  });
  const duplicate = subcategories.find(
    (subcategory) =>
      subcategory.id !== excludeId &&
      normalizeTaxonomyText(subcategory.nombre) === normalized
  );
  if (duplicate) {
    throw taxonomyDuplicate(
      `Ya existe la subcategoría "${duplicate.nombre}" en esta categoría.`
    );
  }
}

async function nextCategorySortOrder(): Promise<number> {
  const prisma = getPrisma();
  const aggregate = await prisma.categoria.aggregate({
    _max: { sortOrder: true },
  });
  return (aggregate._max.sortOrder ?? 0) + 1;
}

async function nextSubcategorySortOrder(idCategoria: number): Promise<number> {
  const prisma = getPrisma();
  const aggregate = await prisma.subcategoria.aggregate({
    where: { idCategoria },
    _max: { sortOrder: true },
  });
  return (aggregate._max.sortOrder ?? 0) + 1;
}

function mapCategoryAdmin(category: {
  id: number;
  nombre: string;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  subcategorias: Array<{
    id: number;
    idCategoria: number;
    nombre: string;
    isActive: boolean;
    isSystem: boolean;
    sortOrder: number;
    _count: { productos: number };
  }>;
}) {
  return {
    id: category.id,
    nombre: category.nombre,
    isActive: category.isActive,
    isSystem: category.isSystem,
    sortOrder: category.sortOrder,
    productCount: category.subcategorias.reduce(
      (total, subcategory) => total + subcategory._count.productos,
      0
    ),
    subcategorias: category.subcategorias.map((subcategory) => ({
      id: subcategory.id,
      idCategoria: subcategory.idCategoria,
      nombre: subcategory.nombre,
      isActive: subcategory.isActive,
      isSystem: subcategory.isSystem,
      sortOrder: subcategory.sortOrder,
      productCount: subcategory._count.productos,
    })),
  };
}

function mapSubcategoryAdmin(subcategory: {
  id: number;
  idCategoria: number;
  nombre: string;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  _count: { productos: number };
}) {
  return {
    id: subcategory.id,
    idCategoria: subcategory.idCategoria,
    nombre: subcategory.nombre,
    isActive: subcategory.isActive,
    isSystem: subcategory.isSystem,
    sortOrder: subcategory.sortOrder,
    productCount: subcategory._count.productos,
  };
}

export async function listCategories() {
  const prisma = getPrisma();

  const categorias = await prisma.categoria.findMany({
    where: {
      isActive: true,
      isSystem: false,
      subcategorias: {
        some: { isActive: true, isSystem: false },
      },
    },
    include: {
      subcategorias: {
        where: { isActive: true, isSystem: false },
        orderBy: [{ sortOrder: 'asc' }, { nombre: 'asc' }],
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { nombre: 'asc' }],
  });

  return categorias.map((categoria) => ({
    id: categoria.id,
    nombre: categoria.nombre,
    subcategorias: categoria.subcategorias.map((subcategoria) => ({
      id: subcategoria.id,
      nombre: subcategoria.nombre,
    })),
  }));
}

export async function listCategoriesAdmin() {
  const prisma = getPrisma();

  const categorias = await prisma.categoria.findMany({
    include: {
      subcategorias: {
        orderBy: [{ sortOrder: 'asc' }, { nombre: 'asc' }],
        include: { _count: { select: { productos: true } } },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { nombre: 'asc' }],
  });

  return categorias.map(mapCategoryAdmin);
}

export async function createCategory(input: CategoryCreateBody) {
  const prisma = getPrisma();
  await assertCategoryNameAvailable(input.nombre);

  const normalizedSubcategories = input.subcategorias.map((nombre) =>
    nombre.trim()
  );
  const seenSubcategories = new Set<string>();
  for (const nombre of normalizedSubcategories) {
    const key = normalizeTaxonomyText(nombre);
    if (seenSubcategories.has(key)) {
      throw taxonomyDuplicate(
        `La subcategoría "${nombre}" está repetida en la solicitud.`
      );
    }
    seenSubcategories.add(key);
  }

  const sortOrder = await nextCategorySortOrder();

  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.categoria.create({
        data: {
          nombre: input.nombre,
          isActive: true,
          isSystem: false,
          sortOrder,
        },
      });
      const subcategories = [];
      for (const [index, nombre] of normalizedSubcategories.entries()) {
        subcategories.push(
          await tx.subcategoria.create({
            data: {
              idCategoria: category.id,
              nombre,
              isActive: true,
              isSystem: false,
              sortOrder: index + 1,
            },
          })
        );
      }
      return {
        id: category.id,
        nombre: category.nombre,
        isActive: category.isActive,
        isSystem: category.isSystem,
        sortOrder: category.sortOrder,
        productCount: 0,
        subcategorias: subcategories.map((subcategory) => ({
          id: subcategory.id,
          idCategoria: subcategory.idCategoria,
          nombre: subcategory.nombre,
          isActive: subcategory.isActive,
          isSystem: subcategory.isSystem,
          sortOrder: subcategory.sortOrder,
          productCount: 0,
        })),
      };
    });
  } catch (error) {
    rethrowTaxonomyPersistenceError(error);
  }
}

export async function updateCategory(id: number, input: CategoryUpdateBody) {
  const prisma = getPrisma();
  const existing = await prisma.categoria.findUnique({ where: { id } });
  if (!existing) {
    throw taxonomyNotFound('Categoría no encontrada.');
  }
  if (existing.isSystem) {
    throw taxonomySystemProtected();
  }
  if (input.nombre !== undefined) {
    await assertCategoryNameAvailable(input.nombre, id);
  }

  try {
    await prisma.categoria.update({
      where: { id },
      data: {
        ...(input.nombre !== undefined ? { nombre: input.nombre } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    rethrowTaxonomyPersistenceError(error);
  }

  const updated = await prisma.categoria.findUniqueOrThrow({
    where: { id },
    include: {
      subcategorias: {
        orderBy: [{ sortOrder: 'asc' }, { nombre: 'asc' }],
        include: { _count: { select: { productos: true } } },
      },
    },
  });
  return mapCategoryAdmin(updated);
}

export async function deleteCategory(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.categoria.findUnique({
    where: { id },
    include: { _count: { select: { subcategorias: true } } },
  });
  if (!existing) {
    throw taxonomyNotFound('Categoría no encontrada.');
  }
  if (existing.isSystem) {
    throw taxonomySystemProtected();
  }
  if (existing._count.subcategorias > 0) {
    throw taxonomyInUse(
      'No puedes eliminar una categoría con subcategorías. Elimina o mueve sus subcategorías primero.'
    );
  }
  await prisma.categoria.delete({ where: { id } });
  return { id };
}

export async function createSubcategory(input: SubcategoryCreateBody) {
  const prisma = getPrisma();
  const category = await prisma.categoria.findUnique({
    where: { id: input.idCategoria },
  });
  if (!category) {
    throw taxonomyNotFound('Categoría no encontrada.');
  }
  if (category.isSystem) {
    throw taxonomySystemProtected();
  }
  await assertSubcategoryNameAvailable(input.idCategoria, input.nombre);
  const sortOrder =
    input.sortOrder ?? (await nextSubcategorySortOrder(input.idCategoria));

  try {
    const subcategory = await prisma.subcategoria.create({
      data: {
        idCategoria: input.idCategoria,
        nombre: input.nombre,
        isActive: true,
        isSystem: false,
        sortOrder,
      },
      include: { _count: { select: { productos: true } } },
    });
    return mapSubcategoryAdmin(subcategory);
  } catch (error) {
    rethrowTaxonomyPersistenceError(error);
  }
}

export async function updateSubcategory(
  id: number,
  input: SubcategoryUpdateBody
) {
  const prisma = getPrisma();
  const existing = await prisma.subcategoria.findUnique({ where: { id } });
  if (!existing) {
    throw taxonomyNotFound('Subcategoría no encontrada.');
  }
  if (existing.isSystem) {
    throw taxonomySystemProtected();
  }
  if (input.nombre !== undefined) {
    await assertSubcategoryNameAvailable(
      existing.idCategoria,
      input.nombre,
      id
    );
  }

  try {
    await prisma.subcategoria.update({
      where: { id },
      data: {
        ...(input.nombre !== undefined ? { nombre: input.nombre } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    rethrowTaxonomyPersistenceError(error);
  }

  const updated = await prisma.subcategoria.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { productos: true } } },
  });
  return mapSubcategoryAdmin(updated);
}

export async function deleteSubcategory(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.subcategoria.findUnique({
    where: { id },
    include: { _count: { select: { productos: true } } },
  });
  if (!existing) {
    throw taxonomyNotFound('Subcategoría no encontrada.');
  }
  if (existing.isSystem) {
    throw taxonomySystemProtected();
  }
  if (existing._count.productos > 0) {
    throw taxonomyInUse(
      'No puedes eliminar una subcategoría con productos. Reasigna esos productos primero.'
    );
  }
  await prisma.subcategoria.delete({ where: { id } });
  return { id };
}

export async function listCatalogs(query: SimpleListQuery) {
  const prisma = getPrisma();

  const catalogos = await prisma.catalogo.findMany({
    where: { isActive: query.active },
    include: { estado: true },
    orderBy: { id: 'asc' },
  });

  return catalogos.map((catalogo) => ({
    id: catalogo.id,
    keyword: catalogo.keyword,
    archivo: catalogo.archivo,
    vigenciaDocumento: catalogo.vigenciaDocumento,
    paginas: catalogo.paginas,
    driveUrl: catalogo.driveUrl,
    aprobado: catalogo.aprobado,
    observaciones: catalogo.observaciones,
    estado: mapEstado(catalogo.estado),
    isActive: catalogo.isActive,
  }));
}

export async function listLocations(query: SimpleListQuery) {
  const prisma = getPrisma();

  const ubicaciones = await prisma.ubicacion.findMany({
    where: { isActive: query.active },
    include: { estado: true },
    orderBy: { ciudad: 'asc' },
  });

  return ubicaciones.map((ubicacion) => ({
    id: ubicacion.idUbicacion,
    ciudad: ubicacion.ciudad,
    direccion: ubicacion.direccion,
    mapsUrl: ubicacion.mapsUrl,
    aprobado: ubicacion.aprobado,
    fuente: ubicacion.fuente,
    horario: ubicacion.horario,
    contacto: ubicacion.contacto,
    estado: mapEstado(ubicacion.estado),
    isActive: ubicacion.isActive,
  }));
}

type WarrantyWithEstado = Prisma.GarantiaGetPayload<{ include: { estado: true } }>;

function mapWarranty(garantia: WarrantyWithEstado) {
  return {
    id: garantia.idGarantia,
    meses: garantia.garantiaMeses,
    especial: garantia.garantiaEspecial,
    observaciones: garantia.observaciones,
    fuenteUrl: garantia.fuenteUrl,
    estado: mapEstado(garantia.estado),
    isActive: garantia.isActive,
    createdAt: garantia.createdAt,
    updatedAt: garantia.updatedAt,
  };
}

export async function listWarranties(query: WarrantyListQuery) {
  const prisma = getPrisma();

  const garantias = await prisma.garantia.findMany({
    where: query.active === undefined ? {} : { isActive: query.active },
    include: { estado: true },
    orderBy: { idGarantia: 'asc' },
  });

  return garantias.map(mapWarranty);
}

export async function createWarranty(input: WarrantyCreateBody) {
  const prisma = getPrisma();
  const estados = await resolveSyncEstados();
  const isActive = input.isActive ?? true;

  const garantia = await prisma.garantia.create({
    data: {
      garantiaMeses: input.meses ?? null,
      garantiaEspecial: input.especial?.trim() || null,
      observaciones: input.observaciones?.trim() || null,
      fuenteUrl: input.fuenteUrl?.trim() || null,
      estadoId: isActive ? estados.activeId : estados.inactiveId,
      isActive,
      updatedAt: new Date(),
    },
    include: { estado: true },
  });

  return mapWarranty(garantia);
}

export async function updateWarranty(id: number, input: WarrantyUpdateBody) {
  const prisma = getPrisma();
  const existing = await prisma.garantia.findUnique({
    where: { idGarantia: id },
    select: { idGarantia: true },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Garantía no encontrada.',
      'ALTOSA_WARRANTY_NOT_FOUND'
    );
  }

  const estados =
    input.isActive !== undefined ? await resolveSyncEstados() : null;
  const data: Prisma.GarantiaUncheckedUpdateInput = { updatedAt: new Date() };

  if (input.meses !== undefined) {
    data.garantiaMeses = input.meses;
  }
  if (input.especial !== undefined) {
    data.garantiaEspecial = input.especial?.trim() || null;
  }
  if (input.observaciones !== undefined) {
    data.observaciones = input.observaciones?.trim() || null;
  }
  if (input.fuenteUrl !== undefined) {
    data.fuenteUrl = input.fuenteUrl?.trim() || null;
  }
  if (input.isActive !== undefined && estados) {
    data.isActive = input.isActive;
    data.estadoId = input.isActive ? estados.activeId : estados.inactiveId;
  }

  const garantia = await prisma.garantia.update({
    where: { idGarantia: id },
    data,
    include: { estado: true },
  });

  return mapWarranty(garantia);
}

export async function deleteWarranty(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.garantia.findUnique({
    where: { idGarantia: id },
    select: { idGarantia: true },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Garantía no encontrada.',
      'ALTOSA_WARRANTY_NOT_FOUND'
    );
  }

  const usedBy = await prisma.productoVariante.count({
    where: { idGarantia: id },
  });
  if (usedBy > 0) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `La garantía está asignada a ${usedBy} variante(s). Desactívala en su lugar o reasigna esas variantes.`,
      'ALTOSA_WARRANTY_IN_USE'
    );
  }

  await prisma.garantia.delete({ where: { idGarantia: id } });
  return { id, deleted: true };
}

const DOCUMENT_BASE_SELECT = {
  id: true,
  externalId: true,
  title: true,
  source: true,
  sourceVersion: true,
  chunkIndex: true,
  embeddingModel: true,
  isActive: true,
  updatedAt: true,
} as const;

function mapDocumentoBase(documento: {
  id: bigint;
  externalId: string | null;
  title: string | null;
  source: string | null;
  sourceVersion: string | null;
  chunkIndex: number;
  embeddingModel: string | null;
  isActive: boolean;
  updatedAt: Date;
}) {
  return {
    id: Number(documento.id),
    externalId: documento.externalId,
    title: documento.title,
    source: documento.source,
    sourceVersion: documento.sourceVersion,
    chunkIndex: documento.chunkIndex,
    embeddingModel: documento.embeddingModel,
    isActive: documento.isActive,
    updatedAt: documento.updatedAt,
  };
}

export async function listDocuments(query: DocumentsQuery) {
  const prisma = getPrisma();

  const where: Prisma.DocumentoWhereInput = {
    isActive: query.active,
    ...(query.source ? { source: query.source } : {}),
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
  };

  const skip = (query.page - 1) * query.pageSize;
  const take = query.pageSize;

  if (query.includeContent) {
    const [total, documentos] = await prisma.$transaction([
      prisma.documento.count({ where }),
      prisma.documento.findMany({
        where,
        select: { ...DOCUMENT_BASE_SELECT, content: true },
        orderBy: { id: 'asc' },
        skip,
        take,
      }),
    ]);

    return {
      items: documentos.map((documento) => ({
        ...mapDocumentoBase(documento),
        content: documento.content,
      })),
      total,
    };
  }

  const [total, documentos] = await prisma.$transaction([
    prisma.documento.count({ where }),
    prisma.documento.findMany({
      where,
      select: DOCUMENT_BASE_SELECT,
      orderBy: { id: 'asc' },
      skip,
      take,
    }),
  ]);

  return { items: documentos.map(mapDocumentoBase), total };
}

// ---------------------------------------------------------------------------
// Escritura (CRUD). El estado 1 = "activo" es el default del pipeline.
// ---------------------------------------------------------------------------

async function ensureSubcategoriaExists(id: number): Promise<void> {
  const found = await getPrisma().subcategoria.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Subcategoría no encontrada.', 'ALTOSA_SUBCATEGORY_NOT_FOUND');
  }
}

async function ensureEstadoExists(id: number): Promise<void> {
  const found = await getPrisma().estado.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Estado no encontrado.', 'ALTOSA_ESTADO_NOT_FOUND');
  }
}

async function ensureGarantiaExists(id: number): Promise<void> {
  const found = await getPrisma().garantia.findUnique({ where: { idGarantia: id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Garantía no encontrada.', 'ALTOSA_WARRANTY_NOT_FOUND');
  }
}

async function ensureCatalogoExists(id: number): Promise<void> {
  const found = await getPrisma().catalogo.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Catálogo no encontrado.', 'ALTOSA_CATALOG_NOT_FOUND');
  }
}

async function ensureSkuAvailable(sku: string | undefined, excludeVariantId?: number): Promise<void> {
  const normalized = sku?.trim();
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      sku: normalized,
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(StatusCodes.CONFLICT, `El SKU "${normalized}" ya está en uso.`, 'ALTOSA_SKU_TAKEN');
  }
}

function normalizeMetaRetailerId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeContificoId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function ensureMetaRetailerIdAvailable(
  metaRetailerId: string | null | undefined,
  excludeVariantId?: number
): Promise<void> {
  const normalized = normalizeMetaRetailerId(metaRetailerId);
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      metaRetailerId: { equals: normalized, mode: 'insensitive' },
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `El Retailer ID "${normalized}" ya está asignado a otra variante.`,
      'META_RETAILER_ID_DUPLICATED'
    );
  }
}

async function ensureMetaRetailerIdExists(
  metaRetailerId: string | null | undefined
): Promise<void> {  const normalized = normalizeMetaRetailerId(metaRetailerId);
  if (!normalized) {
    return;
  }
  const item = await findMetaCatalogItem(normalized);
  if (!item) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      `El Retailer ID "${normalized}" no existe en el catálogo de Meta.`,
      'META_ITEM_NOT_FOUND'
    );
  }
}

async function ensureContificoIdAvailable(
  contificoId: string | null | undefined,
  excludeVariantId?: number
): Promise<void> {
  const normalized = normalizeContificoId(contificoId);
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      contificoId: { equals: normalized, mode: 'insensitive' },
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `El producto de Contifico "${normalized}" ya está asignado a otra variante.`,
      'CONTIFICO_ID_DUPLICATED'
    );
  }
}

function ensureUniqueMetaRetailerIdsInBatch(variants: VariantBody[]): void {
  const seen = new Set<string>();
  for (const variant of variants) {
    const normalized = normalizeMetaRetailerId(variant.metaRetailerId);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      throw new HttpError(
        StatusCodes.CONFLICT,
        `El Retailer ID "${normalized}" está repetido en el mismo producto.`,
        'META_RETAILER_ID_DUPLICATED'
      );
    }
    seen.add(key);
  }
}

async function validateVariantReferences(input: VariantBody | UpdateVariantBody): Promise<void> {
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }
  if (input.garantiaId !== undefined && input.garantiaId !== null) {
    await ensureGarantiaExists(input.garantiaId);
  }
  if (input.catalogoId !== undefined) {
    await ensureCatalogoExists(input.catalogoId);
  }
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }
}

function variantCreateData(input: VariantBody, productName: string) {
  return {
    sku: input.sku?.trim() || null,
    nombre: input.nombre?.trim() || buildFlatName(productName, input.color ?? null),
    color: input.color || null,
    descripcion: input.descripcion || null,
    precioUsd: input.precioUsd ?? null,
    porcentajeIva: input.porcentajeIva ?? 15,
    material: input.material || null,
    tapizado: input.tapizado || null,
    estructura: input.estructura || null,
    mecanismo: input.mecanismo || null,
    proteccionUv: input.proteccionUv || null,
    resistenciaIntemperie: input.resistenciaIntemperie || null,
    apilable: input.apilable || null,
    brazos: input.brazos || null,
    soporteLumbar: input.soporteLumbar || null,
    cabecera: input.cabecera || null,
    usoRecomendado: input.usoRecomendado || null,
    especificacionesAdicionales: input.especificacionesAdicionales || null,
    imagenUrl: input.imagenUrl || null,
    urlProducto: input.urlProducto || null,
    anchoTotalCm: input.anchoTotalCm ?? null,
    profundidadAsientoCm: input.profundidadAsientoCm ?? null,
    alturaTotalCm: input.alturaTotalCm || null,
    alturaAsientoCm: input.alturaAsientoCm || null,
    anchoAsientoCm: input.anchoAsientoCm ?? null,
    pesoKg: input.pesoKg ?? null,
    idGarantia: input.garantiaId ?? null,
    idCatalogo: input.catalogoId ?? null,
    kommoTemplateId: input.kommoTemplateId || null,
    metaRetailerId: normalizeMetaRetailerId(input.metaRetailerId),
    metaMappingLocked:
      normalizeMetaRetailerId(input.metaRetailerId) !== null
        ? input.metaMappingLocked ?? true
        : input.metaMappingLocked ?? false,
    contificoId: normalizeContificoId(input.contificoId),
    contificoSku: input.contificoSku?.trim() || null,
    contificoMappingLocked:
      input.contificoMappingLocked ??
      normalizeContificoId(input.contificoId) !== null,
  };
}

function variantUpdateData(input: UpdateVariantBody): Prisma.ProductoVarianteUncheckedUpdateInput {
  const data: Prisma.ProductoVarianteUncheckedUpdateInput = {};

  if (input.sku !== undefined) data.sku = input.sku.trim() || null;
  if (input.nombre !== undefined) data.nombre = input.nombre.trim() || null;
  if (input.color !== undefined) data.color = input.color || null;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion || null;
  if (input.precioUsd !== undefined) data.precioUsd = input.precioUsd;
  if (input.porcentajeIva !== undefined) data.porcentajeIva = input.porcentajeIva;
  if (input.material !== undefined) data.material = input.material || null;
  if (input.tapizado !== undefined) data.tapizado = input.tapizado || null;
  if (input.estructura !== undefined) data.estructura = input.estructura || null;
  if (input.mecanismo !== undefined) data.mecanismo = input.mecanismo || null;
  if (input.proteccionUv !== undefined) data.proteccionUv = input.proteccionUv || null;
  if (input.resistenciaIntemperie !== undefined) data.resistenciaIntemperie = input.resistenciaIntemperie || null;
  if (input.apilable !== undefined) data.apilable = input.apilable || null;
  if (input.brazos !== undefined) data.brazos = input.brazos || null;
  if (input.soporteLumbar !== undefined) data.soporteLumbar = input.soporteLumbar || null;
  if (input.cabecera !== undefined) data.cabecera = input.cabecera || null;
  if (input.usoRecomendado !== undefined) data.usoRecomendado = input.usoRecomendado || null;
  if (input.especificacionesAdicionales !== undefined) data.especificacionesAdicionales = input.especificacionesAdicionales || null;
  if (input.imagenUrl !== undefined) data.imagenUrl = input.imagenUrl || null;
  if (input.urlProducto !== undefined) data.urlProducto = input.urlProducto || null;
  if (input.anchoTotalCm !== undefined) data.anchoTotalCm = input.anchoTotalCm;
  if (input.profundidadAsientoCm !== undefined) data.profundidadAsientoCm = input.profundidadAsientoCm;
  if (input.alturaTotalCm !== undefined) data.alturaTotalCm = input.alturaTotalCm || null;
  if (input.alturaAsientoCm !== undefined) data.alturaAsientoCm = input.alturaAsientoCm || null;
  if (input.anchoAsientoCm !== undefined) data.anchoAsientoCm = input.anchoAsientoCm;
  if (input.pesoKg !== undefined) data.pesoKg = input.pesoKg;
  if (input.garantiaId !== undefined) data.idGarantia = input.garantiaId;
  if (input.catalogoId !== undefined) data.idCatalogo = input.catalogoId;
  if (input.estadoId !== undefined) data.estadoId = input.estadoId;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.kommoTemplateId !== undefined) {
    data.kommoTemplateId = input.kommoTemplateId || null;
  }
  if (input.metaRetailerId !== undefined) {
    data.metaRetailerId = normalizeMetaRetailerId(input.metaRetailerId);
    data.metaMappingLocked = input.metaMappingLocked === false ? false : true;
  } else if (input.metaMappingLocked !== undefined) {
    data.metaMappingLocked = input.metaMappingLocked;
  }
  if (input.contificoId !== undefined) {
    data.contificoId = normalizeContificoId(input.contificoId);
    data.contificoMappingLocked = input.contificoMappingLocked === false ? false : true;
  } else if (input.contificoMappingLocked !== undefined) {
    data.contificoMappingLocked = input.contificoMappingLocked;
  }
  if (input.contificoSku !== undefined) {
    data.contificoSku = input.contificoSku?.trim() || null;
  }

  return data;
}

export async function createProduct(input: CreateProductBody) {
  const prisma = getPrisma();

  await ensureSubcategoriaExists(input.subcategoryId);
  await ensureEstadoExists(input.estadoId);
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }

  ensureUniqueMetaRetailerIdsInBatch(input.variantes);

  for (const variante of input.variantes) {
    await ensureSkuAvailable(variante.sku);
    await ensureMetaRetailerIdExists(variante.metaRetailerId);
    await ensureMetaRetailerIdAvailable(variante.metaRetailerId);
    await ensureContificoIdAvailable(variante.contificoId);
    await validateVariantReferences(variante);
  }

  const now = new Date();
  const created = await prisma.producto.create({
    data: {
      idSubCategoria: input.subcategoryId,
      producto: input.nombre,
      descripcion: input.descripcion || null,
      usoRecomendado: input.usoRecomendado || null,
      palabrasClave:
        input.keywords !== undefined
          ? serializeKeywords(input.keywords)
          : null,
      estadoId: input.estadoId,
      isActive: input.estadoId === ESTADO_ACTIVO,
      kommoTemplateId: input.kommoTemplateId || null,
      createdAt: now,
      updatedAt: now,
      variants: {
        create: input.variantes.map((variante) => {
          const estadoId =
            variante.estadoId ??
            (variante.isActive === false ? ESTADO_INACTIVO : input.estadoId);
          return {
            ...variantCreateData(variante, input.nombre),
            estadoId,
            isActive: estadoId === ESTADO_ACTIVO,
            createdAt: now,
            updatedAt: now,
          };
        }),
      },
    },
  });

  if (input.writeThroughContifico) {
    const taxonomy = await prisma.subcategoria.findUnique({
      where: { id: input.subcategoryId },
      select: { nombre: true },
    });
    const subcategoryName = taxonomy?.nombre ?? null;
    const variants = await prisma.productoVariante.findMany({
      where: { idProducto: created.idProducto },
      select: {
        idVariante: true,
        sku: true,
        nombre: true,
        color: true,
        descripcion: true,
        precioUsd: true,
        porcentajeIva: true,
        isActive: true,
        contificoId: true,
      },
    });
    for (const variant of variants) {
      if (!variant.isActive || variant.contificoId) {
        continue;
      }
      try {
        const mapping = await createContificoProductForVariant({
          productName: input.nombre,
          variantName: variant.nombre,
          sku: variant.sku,
          color: variant.color,
          description: variant.descripcion,
          price: variant.precioUsd === null ? null : Number(variant.precioUsd),
          porcentajeIva: variant.porcentajeIva,
          isActive: variant.isActive,
          subcategoryName,
        });
        if (mapping) {
          await prisma.productoVariante.update({
            where: { idVariante: variant.idVariante },
            data: mapping,
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, productId: created.idProducto, variantId: variant.idVariante },
          'No se pudo crear el producto plano en Contifico; queda pendiente de mapeo'
        );
      }
    }
  }

  if (input.writeThroughMeta) {
    const variants = await prisma.productoVariante.findMany({
      where: { idProducto: created.idProducto },
      select: { idVariante: true, isActive: true, metaRetailerId: true },
    });
    for (const variant of variants) {
      if (!variant.isActive || variant.metaRetailerId) {
        continue;
      }
      try {
        await publishVariantById(variant.idVariante);
      } catch (error) {
        logger.warn(
          { err: error, productId: created.idProducto, variantId: variant.idVariante },
          'No se pudo publicar la variante en Meta; queda pendiente de mapeo'
        );
      }
    }
  }

  return getProductById(created.idProducto);
}

export async function updateProduct(
  id: number,
  input: UpdateProductBody,
  options: { skipMeta?: boolean } = {}
) {
  const prisma = getPrisma();

  const existing = await prisma.producto.findUnique({
    where: { idProducto: id },
    select: {
      idProducto: true,
      producto: true,
      descripcion: true,
      estadoId: true,
      subcategoria: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
      variants: {
        select: {
          idVariante: true,
          sku: true,
          nombre: true,
          color: true,
          descripcion: true,
          precioUsd: true,
          isActive: true,
          imagenUrl: true,
          urlProducto: true,
          contificoId: true,
          metaRetailerId: true,
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  const taxonomy = input.subcategoryId
    ? await prisma.subcategoria.findUnique({
        where: { id: input.subcategoryId },
        select: { nombre: true },
      })
    : existing.subcategoria;
  const subcategoryName =
    taxonomy?.nombre ?? existing.subcategoria?.nombre ?? null;
  const resolvedEstado = resolveEstadoFields(input);
  let resolvedIsActive = resolvedEstado.isActive;
  let resolvedEstadoId = resolvedEstado.estadoId;

  // Guardar un cambio en un producto anulado no lo resucita como inactivo.
  // Solo un estado explícito o isActive=true lo restaura.
  if (
    input.estadoId === undefined &&
    input.isActive === false &&
    existing.estadoId === ESTADO_ANULADO
  ) {
    resolvedEstadoId = ESTADO_ANULADO;
    resolvedIsActive = false;
  }

  if (
    input.nombre !== undefined ||
    input.descripcion !== undefined ||
    input.isActive !== undefined ||
    input.estadoId !== undefined ||
    input.subcategoryId !== undefined
  ) {
    const variantNames = new Map(
      existing.variants.map((variant) => [
        variant.idVariante,
        resolveExternalVariantName({
          existingName: variant.nombre,
          oldProductName: existing.producto,
          newProductName: input.nombre ?? existing.producto,
          oldColor: variant.color,
          newColor: variant.color,
        }),
      ])
    );

    for (const variant of existing.variants) {
      if (!variant.contificoId) {
        continue;
      }
      try {
        await updateContificoProductForVariant(variant.contificoId, {
          productName: input.nombre ?? existing.producto,
          variantName: variantNames.get(variant.idVariante) ?? variant.nombre,
          sku: variant.sku,
          color: variant.color,
          description:
            input.descripcion !== undefined
              ? input.descripcion
              : variant.descripcion,
          price: variant.precioUsd === null ? null : Number(variant.precioUsd),
          isActive: resolvedIsActive ?? variant.isActive,
          subcategoryName,
        });
      } catch (error) {
        logger.warn(
          { err: error, variantId: variant.idVariante, contificoId: variant.contificoId },
          'El producto se actualizó en Altosa, pero no se pudo actualizar en Contifico; la salud lo reportará'
        );
      }
    }

    for (const variant of existing.variants) {
      if (options.skipMeta || !variant.metaRetailerId) {
        continue;
      }
      try {
        await updateVariantInMeta(variant.idVariante, {
          productName: input.nombre ?? existing.producto,
          variantName: variantNames.get(variant.idVariante) ?? variant.nombre,
          color: variant.color,
          description:
            input.descripcion !== undefined
              ? input.descripcion
              : variant.descripcion,
          price: variant.precioUsd === null ? null : Number(variant.precioUsd),
          imageUrl: variant.imagenUrl,
          url: variant.urlProducto,
          isActive: resolvedIsActive ?? variant.isActive,
        });
      } catch (error) {
        logger.warn(
          { err: error, variantId: variant.idVariante, metaRetailerId: variant.metaRetailerId },
          'El producto se actualizó en Altosa, pero no se pudo actualizar en Meta; la salud lo reportará'
        );
      }
    }

    // Si el nombre de la variante era el automático (producto + color), se
    // renombra junto con el producto. Los nombres manuales se respetan.
    if (input.nombre !== undefined) {
      for (const variant of existing.variants) {
        const nextName = variantNames.get(variant.idVariante);
        if (nextName && nextName !== (variant.nombre ?? '')) {
          await prisma.productoVariante.update({
            where: { idVariante: variant.idVariante },
            data: { nombre: nextName, updatedAt: new Date() },
          });
        }
      }
    }
  }

  if (input.subcategoryId !== undefined) {
    await ensureSubcategoriaExists(input.subcategoryId);
  }
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }

  const data: Prisma.ProductoUncheckedUpdateInput = { updatedAt: new Date() };
  if (input.nombre !== undefined) data.producto = input.nombre;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion || null;
  if (input.usoRecomendado !== undefined) data.usoRecomendado = input.usoRecomendado || null;
  if (input.keywords !== undefined) {
    data.palabrasClave = serializeKeywords(input.keywords);
  }
  if (input.subcategoryId !== undefined) data.idSubCategoria = input.subcategoryId;
  if (resolvedEstadoId !== undefined) data.estadoId = resolvedEstadoId;
  if (resolvedIsActive !== undefined) data.isActive = resolvedIsActive;
  if (input.kommoTemplateId !== undefined) {
    data.kommoTemplateId = input.kommoTemplateId || null;
  }

  await prisma.producto.update({ where: { idProducto: id }, data });

  if (
    resolvedEstadoId === ESTADO_ANULADO ||
    resolvedEstadoId === ESTADO_INACTIVO
  ) {
    await prisma.productoVariante.updateMany({
      where: { idProducto: id },
      data: {
        estadoId: resolvedEstadoId,
        isActive: false,
        updatedAt: new Date(),
      },
    });
  }

  return getProductById(id);
}

type VariantExternalFields = {
  idVariante: number;
  sku: string | null;
  color: string | null;
  descripcion: string | null;
  precioUsd: Prisma.Decimal | null;
  imagenUrl: string | null;
  urlProducto: string | null;
  contificoId: string | null;
  metaRetailerId: string | null;
  producto: {
    producto: string;
    subcategoria: {
      nombre: string;
      categoria: { nombre: string };
    } | null;
  };
};

async function deactivateVariantExternally(
  variant: VariantExternalFields
): Promise<void> {
  const price =
    variant.precioUsd === null ? null : Number(variant.precioUsd);
  const subcategoryName = variant.producto.subcategoria?.nombre ?? null;

  if (variant.metaRetailerId) {
    try {
      await updateVariantInMeta(variant.idVariante, {
        productName: variant.producto.producto,
        color: variant.color,
        description: variant.descripcion,
        price,
        imageUrl: variant.imagenUrl,
        url: variant.urlProducto,
        isActive: false,
      });
    } catch (error) {
      logger.warn(
        { err: error, variantId: variant.idVariante, metaRetailerId: variant.metaRetailerId },
        'La variante se anuló en Altosa, pero no se pudo desactivar en Meta'
      );
    }
  }

  if (variant.contificoId) {
    try {
      await updateContificoProductForVariant(variant.contificoId, {
        productName: variant.producto.producto,
        sku: variant.sku,
        color: variant.color,
        description: variant.descripcion,
        price,
        isActive: false,
        subcategoryName,
      });
    } catch (error) {
      logger.warn(
        { err: error, variantId: variant.idVariante, contificoId: variant.contificoId },
        'La variante se anuló en Altosa, pero no se pudo desactivar en Contifico'
      );
    }
  }
}

/**
 * Anulación lógica: el producto y sus variantes pasan a estado 3 (anulado),
 * isActive=false. No se borran de Altosa ni de Meta/Contifico; se desactivan
 * en los catálogos externos. El borrado definitivo solo se permite después.
 */
export async function annulProduct(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.producto.findUnique({
    where: { idProducto: id },
    select: {
      idProducto: true,
      estadoId: true,
      producto: true,
      subcategoria: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
      variants: {
        select: {
          idVariante: true,
          sku: true,
          color: true,
          descripcion: true,
          precioUsd: true,
          imagenUrl: true,
          urlProducto: true,
          contificoId: true,
          metaRetailerId: true,
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Producto no encontrado.',
      'ALTOSA_PRODUCT_NOT_FOUND'
    );
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.producto.update({
      where: { idProducto: id },
      data: { estadoId: ESTADO_ANULADO, isActive: false, updatedAt: now },
    }),
    prisma.productoVariante.updateMany({
      where: { idProducto: id },
      data: { estadoId: ESTADO_ANULADO, isActive: false, updatedAt: now },
    }),
  ]);

  for (const variant of existing.variants) {
    await deactivateVariantExternally({
      ...variant,
      producto: {
        producto: existing.producto,
        subcategoria: existing.subcategoria,
      },
    });
  }

  return getProductById(id);
}

/**
 * Borrado definitivo: solo si el producto ya está anulado. Elimina los ítems
 * externos (Meta/Contifico) y luego borra las filas de Altosa.
 */
export async function deactivateProduct(id: number) {
  return annulProduct(id);
}

export async function createVariant(productId: number, input: VariantBody) {
  const prisma = getPrisma();

  const producto = await prisma.producto.findUnique({
    where: { idProducto: productId },
    select: {
      idProducto: true,
      estadoId: true,
      producto: true,
      subcategoria: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
    },
  });
  if (!producto) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  await ensureSkuAvailable(input.sku);
  await ensureMetaRetailerIdExists(input.metaRetailerId);
  await ensureMetaRetailerIdAvailable(input.metaRetailerId);
  await ensureContificoIdAvailable(input.contificoId);
  await validateVariantReferences(input);

  const now = new Date();
  const variantEstadoId =
    input.estadoId ??
    (input.isActive === false ? ESTADO_INACTIVO : producto.estadoId);
  const created = await prisma.productoVariante.create({
    data: {
      idProducto: productId,
      ...variantCreateData(input, producto.producto),
      estadoId: variantEstadoId,
      isActive: variantEstadoId === ESTADO_ACTIVO,
      createdAt: now,
      updatedAt: now,
    },
    include: VARIANT_RELATIONS,
  });

  if (input.writeThroughContifico) {
    try {
      const mapping = await createContificoProductForVariant({
        productName: producto.producto,
        variantName: created.nombre,
        sku: created.sku,
        color: created.color,
        description: created.descripcion,
        price: created.precioUsd === null ? null : Number(created.precioUsd),
        porcentajeIva: created.porcentajeIva,
        isActive: created.isActive,
        subcategoryName: producto.subcategoria?.nombre ?? null,
      });
      if (mapping) {
        await prisma.productoVariante.update({
          where: { idVariante: created.idVariante },
          data: mapping,
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, productId, variantId: created.idVariante },
        'Variante creada en Altosa, pero no se pudo crear su producto en Contifico'
      );
    }
  }

  if (input.writeThroughMeta) {
    try {
      await publishVariantById(created.idVariante);
    } catch (error) {
      logger.warn(
        { err: error, productId, variantId: created.idVariante },
        'Variante creada en Altosa, pero no se pudo publicar en Meta'
      );
    }
  }

  const saved = await prisma.productoVariante.findUniqueOrThrow({
    where: { idVariante: created.idVariante },
    include: VARIANT_RELATIONS,
  });
  return mapVariante(saved);
}

export async function updateVariant(
  variantId: number,
  input: UpdateVariantBody,
  options: { skipMeta?: boolean } = {}
) {
  const prisma = getPrisma();

  const existing = await prisma.productoVariante.findUnique({
    where: { idVariante: variantId },
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      nombre: true,
      descripcion: true,
      precioUsd: true,
      porcentajeIva: true,
      isActive: true,
      estadoId: true,
      imagenUrl: true,
      urlProducto: true,
      contificoId: true,
      metaRetailerId: true,
      producto: {
        select: {
          producto: true,
          subcategoria: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Variante no encontrada.', 'ALTOSA_VARIANT_NOT_FOUND');
  }

  const resolvedEstado = resolveEstadoFields(input);
  let resolvedIsActive = resolvedEstado.isActive;
  let resolvedEstadoId = resolvedEstado.estadoId;

  // Guardar una variante anulada sin cambiar explícitamente el estado no la
  // devuelve a inactiva. Para restaurarla se envía estadoId 1/2 o isActive=true.
  if (
    input.estadoId === undefined &&
    input.isActive === false &&
    existing.estadoId === ESTADO_ANULADO
  ) {
    resolvedEstadoId = ESTADO_ANULADO;
    resolvedIsActive = false;
  }

  if (
    (existing.contificoId || existing.metaRetailerId) &&
    input.sku !== undefined &&
    input.sku !== existing.sku
  ) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'El SKU de una variante mapeada a Contifico/Meta no se puede cambiar desde Altosa. Actualízalo en el catálogo externo o quita el mapeo primero.',
      'EXTERNAL_VARIANT_SKU_LOCKED'
    );
  }

  const externalVariantName = resolveExternalVariantName({
    existingName: existing.nombre,
    oldProductName: existing.producto.producto,
    newProductName: existing.producto.producto,
    oldColor: existing.color,
    newColor: input.color ?? existing.color,
    inputName: input.nombre,
  });

  if (
    existing.contificoId &&
    (input.nombre !== undefined ||
      input.color !== undefined ||
      input.descripcion !== undefined ||
      input.precioUsd !== undefined ||
      input.porcentajeIva !== undefined ||
      input.isActive !== undefined ||
      input.estadoId !== undefined)
  ) {
    try {
      await updateContificoProductForVariant(existing.contificoId, {
        productName: existing.producto.producto,
        variantName: externalVariantName,
        sku: existing.sku,
        color: input.color ?? existing.color,
        description:
          input.descripcion !== undefined
            ? input.descripcion
            : existing.descripcion,
        price:
          input.precioUsd !== undefined
            ? input.precioUsd
            : existing.precioUsd === null
              ? null
              : Number(existing.precioUsd),
        porcentajeIva: input.porcentajeIva ?? existing.porcentajeIva,
        isActive: resolvedIsActive ?? existing.isActive,
        subcategoryName: existing.producto.subcategoria?.nombre ?? null,
      });
    } catch (error) {
      logger.warn(
        { err: error, variantId: existing.idVariante, contificoId: existing.contificoId },
        'La variante se actualizó en Altosa, pero no se pudo actualizar en Contifico; la salud lo reportará'
      );
    }
  }

  if (
    !options.skipMeta &&
    existing.metaRetailerId &&
    (input.nombre !== undefined ||
      input.color !== undefined ||
      input.descripcion !== undefined ||
      input.precioUsd !== undefined ||
      input.imagenUrl !== undefined ||
      input.isActive !== undefined ||
      input.estadoId !== undefined)
  ) {
    try {
      await updateVariantInMeta(variantId, {
        productName: existing.producto.producto,
        variantName: externalVariantName,
        color: input.color ?? existing.color,
        description:
          input.descripcion !== undefined
            ? input.descripcion
            : existing.descripcion,
        price:
          input.precioUsd !== undefined
            ? input.precioUsd
            : existing.precioUsd === null
              ? null
              : Number(existing.precioUsd),
        imageUrl:
          input.imagenUrl !== undefined ? input.imagenUrl : existing.imagenUrl,
        url: existing.urlProducto,
        isActive: resolvedIsActive ?? existing.isActive,
      });
    } catch (error) {
      logger.warn(
        { err: error, variantId: existing.idVariante, metaRetailerId: existing.metaRetailerId },
        'La variante se actualizó en Altosa, pero no se pudo actualizar en Meta; la salud lo reportará'
      );
    }
  }

  if (input.sku !== undefined) {
    await ensureSkuAvailable(input.sku, variantId);
  }
  if (input.metaRetailerId !== undefined) {
    await ensureMetaRetailerIdExists(input.metaRetailerId);
    await ensureMetaRetailerIdAvailable(input.metaRetailerId, variantId);
  }
  if (input.contificoId !== undefined) {
    await ensureContificoIdAvailable(input.contificoId, variantId);
  }
  await validateVariantReferences(input);

  const data = variantUpdateData(input);
  // Compatibilidad con clientes anteriores: si solo envían color y la
  // variante aún no tiene nombre, se genera desde producto + color.
  if (input.nombre === undefined && input.color !== undefined && !existing.nombre) {
    data.nombre = buildFlatName(existing.producto.producto, input.color ?? null);
  }
  if (resolvedEstadoId !== undefined) {
    data.estadoId = resolvedEstadoId;
    data.isActive = resolvedEstadoId === ESTADO_ACTIVO;
  } else if (resolvedIsActive !== undefined) {
    data.isActive = resolvedIsActive;
    data.estadoId = resolvedIsActive ? ESTADO_ACTIVO : ESTADO_INACTIVO;
  }
  if (
    input.nombre !== undefined &&
    input.nombre.trim() === (existing.nombre ?? '').trim() &&
    externalVariantName !== (existing.nombre ?? '')
  ) {
    data.nombre = externalVariantName;
  }
  data.updatedAt = new Date();

  const updated = await prisma.productoVariante.update({
    where: { idVariante: variantId },
    data,
    include: VARIANT_RELATIONS,
  });

  // No auto-mapear al editar: si el usuario quitó un mapeo (Meta o Contifico)
  // debe quedarse quitado. Las variantes nuevas se mapean al crearse y el
  // mapeo manual/sync se hace explícitamente con los selectores del ERP.
  return mapVariante(updated);
}

export async function annulVariant(variantId: number) {
  const prisma = getPrisma();
  const existing = await prisma.productoVariante.findUnique({
    where: { idVariante: variantId },
    select: {
      idVariante: true,
      sku: true,
      color: true,
      descripcion: true,
      precioUsd: true,
      imagenUrl: true,
      urlProducto: true,
      contificoId: true,
      metaRetailerId: true,
      producto: {
        select: {
          producto: true,
          subcategoria: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Variante no encontrada.',
      'ALTOSA_VARIANT_NOT_FOUND'
    );
  }

  const updated = await prisma.productoVariante.update({
    where: { idVariante: variantId },
    data: { estadoId: ESTADO_ANULADO, isActive: false, updatedAt: new Date() },
    include: VARIANT_RELATIONS,
  });

  await deactivateVariantExternally(existing);
  return mapVariante(updated);
}

export async function deactivateVariant(variantId: number) {
  return annulVariant(variantId);
}

// ---------------------------------------------------------------------------
// Borrado definitivo (solo ítems anulados y sin mapeos externos)
// ---------------------------------------------------------------------------

export async function deleteVariantPermanently(variantId: number) {
  const prisma = getPrisma();
  const existing = await prisma.productoVariante.findUnique({
    where: { idVariante: variantId },
    select: {
      idVariante: true,
      sku: true,
      estadoId: true,
      contificoId: true,
      contificoSku: true,
      metaRetailerId: true,
    },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Variante no encontrada.',
      'ALTOSA_VARIANT_NOT_FOUND'
    );
  }
  if (existing.estadoId !== ESTADO_ANULADO) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'Solo se puede eliminar definitivamente una variante anulada.',
      'ALTOSA_PERMANENT_DELETE_NOT_ANNULLED'
    );
  }
  if (existing.contificoId || existing.contificoSku || existing.metaRetailerId) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'La variante está mapeada a Contifico o Meta. Quita los mapeos antes de eliminarla definitivamente.',
      'ALTOSA_PERMANENT_DELETE_MAPPED'
    );
  }

  await prisma.productoVariante.delete({ where: { idVariante: variantId } });
  return { id: variantId, sku: existing.sku, deleted: true as const };
}

export async function deleteProductPermanently(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.producto.findUnique({
    where: { idProducto: id },
    select: {
      idProducto: true,
      estadoId: true,
      variants: {
        select: {
          idVariante: true,
          sku: true,
          contificoId: true,
          contificoSku: true,
          metaRetailerId: true,
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Producto no encontrado.',
      'ALTOSA_PRODUCT_NOT_FOUND'
    );
  }
  if (existing.estadoId !== ESTADO_ANULADO) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'Solo se puede eliminar definitivamente un producto anulado.',
      'ALTOSA_PERMANENT_DELETE_NOT_ANNULLED'
    );
  }
  const mappedVariants = existing.variants.filter(
    (variant) =>
      Boolean(variant.contificoId) ||
      Boolean(variant.contificoSku) ||
      Boolean(variant.metaRetailerId)
  );
  if (mappedVariants.length > 0) {
    const skus = mappedVariants
      .map((variant) => variant.sku)
      .filter((sku): sku is string => Boolean(sku))
      .join(', ');
    throw new HttpError(
      StatusCodes.CONFLICT,
      `El producto tiene variantes mapeadas a Contifico o Meta${
        skus ? ` (${skus})` : ''
      }. Quita los mapeos antes de eliminarlo definitivamente.`,
      'ALTOSA_PERMANENT_DELETE_MAPPED'
    );
  }

  await prisma.$transaction([
    prisma.productoVariante.deleteMany({ where: { idProducto: id } }),
    prisma.producto.delete({ where: { idProducto: id } }),
  ]);
  return {
    id,
    skus: existing.variants
      .map((variant) => variant.sku)
      .filter((sku): sku is string => Boolean(sku)),
    deleted: true as const,
  };
}

// ---------------------------------------------------------------------------
// Sincronización desde Contifico (ERP -> Altosa)
// ---------------------------------------------------------------------------

interface SyncProductsResult {
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  meta?: {
    mapped: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
  };
  contifico?: {
    mapped: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
  };
}

function normalizeSyncVariant(input: SyncProductBody['variantes'][number]) {
  return {
    sku: input.sku,
    nombre: input.nombre?.trim() || null,
    color: input.color?.trim() || null,
    descripcion: input.descripcion?.trim() || null,
    precioUsd: input.precioUsd ?? null,
    imagenUrl: input.imagenUrl?.trim() || null,
    especificaciones: input.especificaciones ?? {},
    isActive: input.isActive,
    contificoId: input.contificoId?.trim() || null,
    contificoSku: input.contificoSku?.trim() || null,
  };
}

/**
 * Conserva especificaciones que ya existían en Altosa (texto plano o JSON de
 * enriquecimiento) y agrega/actualiza las claves que vienen de Contifico.
 */
function mergeSyncSpecs(
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

/**
 * Upsert idempotente por SKU de variante. Es la contraparte del endpoint
 * POST /api/v1/sync/products y también lo usa el seed offline.
 */
export async function syncProducts(
  items: SyncProductBody[],
  options: {
    matchByName?: boolean;
    syncExternals?: boolean;
    writeThroughMeta?: boolean;
    writeThroughContifico?: boolean;
  } = {}
): Promise<SyncProductsResult> {
  const prisma = getPrisma();
  const matchByName = options.matchByName ?? false;
  const syncExternals = options.syncExternals ?? false;
  const writeThroughMeta = options.writeThroughMeta ?? false;
  const writeThroughContifico = options.writeThroughContifico ?? false;
  const estados = await resolveSyncEstados();
  const now = new Date();
  const result: SyncProductsResult = {
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    ...(syncExternals || writeThroughMeta
      ? {
          meta: {
            mapped: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            warnings: [],
          },
        }
      : {}),
    ...(writeThroughContifico
      ? {
          contifico: {
            mapped: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            warnings: [],
          },
        }
      : {}),
  };

  for (const item of items) {
    const taxonomy = item.updateTaxonomy
      ? await resolveTaxonomySelection({
          categoryName: item.categoria,
          subcategoryName: item.subcategoria,
        })
      : await resolveCanonicalTaxonomy({
          categoryName: item.categoria,
          subcategoryName: item.subcategoria,
          productName: item.nombre,
        });

    const estadoId =
      item.estado === 'I' ? estados.inactiveId : estados.activeId;
    const isActive = item.estado !== 'I';
    const variantes =
      item.variantes.length > 0
        ? item.variantes.map(normalizeSyncVariant)
        : [
            {
              sku: item.codigo,
              nombre: item.nombre.trim(),
              color: 'Estándar',
              descripcion: item.descripcion?.trim() || null,
              precioUsd: null,
              imagenUrl: null,
              especificaciones: {},
              isActive,
              contificoId: null,
              contificoSku: null,
            },
          ];

    const primarySku = variantes[0]!.sku;
    const existingVariant = await prisma.productoVariante.findFirst({
      where: { sku: primarySku },
      select: {
        idProducto: true,
        producto: { select: { isActive: true } },
      },
    });

    let productId = existingVariant?.idProducto ?? null;
    let existingProductIsActive = existingVariant?.producto.isActive ?? false;
    let mergePrimaryVariant: {
      idVariante: number;
      nombre: string | null;
      color: string | null;
      descripcion: string | null;
      imagenUrl: string | null;
      especificacionesAdicionales: string | null;
      isActive: boolean;
    } | null = null;

    if (productId === null) {
      const existingProduct = await prisma.producto.findFirst({
        where: {
          producto: { equals: item.nombre.trim(), mode: 'insensitive' },
          ...(matchByName ? {} : { subcategoria: { idCategoria: taxonomy.categoryId } }),
        },
        select: {
          idProducto: true,
          isActive: true,
          variants: {
            select: {
              idVariante: true,
              nombre: true,
              color: true,
              descripcion: true,
              imagenUrl: true,
              especificacionesAdicionales: true,
              isActive: true,
            },
          },
        },
        orderBy: { idProducto: 'asc' },
      });
      productId = existingProduct?.idProducto ?? null;
      existingProductIsActive = existingProduct?.isActive ?? false;

      // Migración inicial desde Altosa: si el producto existe por nombre y
      // tiene una sola variante, reutilizamos esa variante cambiándole el SKU
      // en lugar de crear una variante duplicada.
      if (existingProduct && existingProduct.variants.length === 1) {
        mergePrimaryVariant = existingProduct.variants[0]!;
      }
    }

    if (productId === null) {
      const created = await prisma.producto.create({
        data: {
          idSubCategoria: taxonomy.subcategoryId,
          producto: item.nombre.trim(),
          descripcion: item.descripcion?.trim() || null,
          usoRecomendado: item.usoRecomendado?.trim() || null,
          estadoId,
          isActive,
          updatedAt: now,
        },
      });
      productId = created.idProducto;
      result.productsCreated += 1;
    } else {
      await prisma.producto.update({
        where: { idProducto: productId },
        data: existingProductIsActive
          ? {
              // Un producto aprobado es maestro en Altosa/ERP: el sync de
              // Contifico no debe cambiar nombre, descripción ni uso. Solo se
              // permite mover la taxonomía con un update explícito del ERP.
              ...(item.updateTaxonomy
                ? { idSubCategoria: taxonomy.subcategoryId }
                : {}),
              updatedAt: now,
            }
          : {
              producto: item.nombre.trim(),
              // La taxonomía de Altosa es curada por el equipo de IA: el sync
              // masivo de Contifico conserva categoría/subcategoría. Solo un
              // update explícito del ERP (updateTaxonomy) puede mover el producto.
              ...(item.updateTaxonomy
                ? { idSubCategoria: taxonomy.subcategoryId }
                : {}),
              // Si Contifico no trae descripción, no borramos el enriquecimiento
              // que ya existía en Altosa.
              ...(item.descripcion?.trim()
                ? { descripcion: item.descripcion.trim() }
                : {}),
              ...(item.usoRecomendado?.trim()
                ? { usoRecomendado: item.usoRecomendado.trim() }
                : {}),
              updatedAt: now,
            },
      });
      result.productsUpdated += 1;
    }

    for (const [variantIndex, variante] of variantes.entries()) {
      const existingBySku = await prisma.productoVariante.findFirst({
        where: { sku: variante.sku },
        select: {
          idVariante: true,
          nombre: true,
          color: true,
          descripcion: true,
          imagenUrl: true,
          especificacionesAdicionales: true,
          isActive: true,
          metaRetailerId: true,
          metaMappingLocked: true,
        },
      });
      const existing =
        existingBySku ?? (variantIndex === 0 ? mergePrimaryVariant : null);

      const variantIsActive = variante.isActive ?? isActive;
      const variantEstadoId = variantIsActive ? estados.activeId : estados.inactiveId;
      const existingIsActive = existing?.isActive ?? false;

      const data = existingIsActive
        ? {
            // Variante aprobada: conservar color, descripción e imagen. El
            // sync solo actualiza precio/stock (especificaciones) y los IDs
            // externos que vengan del ERP.
            idProducto: productId,
            sku: variante.sku,
            nombre:
              existing?.nombre ??
              variante.nombre ??
              buildFlatName(item.nombre, variante.color ?? existing?.color ?? null),
            precioUsd: variante.precioUsd,
            especificacionesAdicionales: mergeSyncSpecs(
              existing?.especificacionesAdicionales,
              variante.especificaciones
            ),
            ...(variante.contificoId
              ? {
                  contificoId: variante.contificoId,
                  contificoSku: variante.contificoSku ?? variante.sku,
                }
              : {}),
            updatedAt: now,
          }
        : {
            idProducto: productId,
            sku: variante.sku,
            nombre:
              existing?.nombre ??
              variante.nombre ??
              buildFlatName(item.nombre, variante.color ?? existing?.color ?? null),
            color: variante.color ?? existing?.color ?? null,
            descripcion: variante.descripcion ?? existing?.descripcion ?? null,
            precioUsd: variante.precioUsd,
            imagenUrl: variante.imagenUrl ?? existing?.imagenUrl ?? null,
            especificacionesAdicionales: mergeSyncSpecs(
              existing?.especificacionesAdicionales,
              variante.especificaciones
            ),
            ...(variante.contificoId
              ? {
                  contificoId: variante.contificoId,
                  contificoSku: variante.contificoSku ?? variante.sku,
                }
              : {}),
            updatedAt: now,
          };

      let savedVariant;
      if (existing) {
        savedVariant = await prisma.productoVariante.update({
          where: { idVariante: existing.idVariante },
          data,
        });
        result.variantsUpdated += 1;
      } else {
        savedVariant = await prisma.productoVariante.create({
          data: {
            ...data,
            estadoId: variantEstadoId,
            isActive: variantIsActive,
          },
        });
        result.variantsCreated += 1;
      }

      if (writeThroughMeta && result.meta && savedVariant.metaRetailerId) {
        try {
          await updateVariantInMeta(savedVariant.idVariante, {
            productName: item.nombre,
            color: savedVariant.color,
            description: savedVariant.descripcion,
            price:
              savedVariant.precioUsd === null
                ? null
                : Number(savedVariant.precioUsd),
            imageUrl: savedVariant.imagenUrl,
            url: savedVariant.urlProducto,
            isActive: savedVariant.isActive,
          });
          result.meta.updated += 1;
        } catch (error) {
          result.meta.failed += 1;
          const message =
            error instanceof Error ? error.message : 'Error desconocido actualizando Meta';
          result.meta.warnings.push(
            `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
          );
          logger.warn(
            { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
            'No se pudo actualizar la variante en Meta'
          );
        }
      }

      if (
        syncExternals &&
        result.meta &&
        savedVariant.isActive &&
        !savedVariant.metaRetailerId
      ) {
        try {
          const published = await publishVariantToMeta({
            retailerId: savedVariant.sku?.trim() || `ALT-${savedVariant.idVariante}`,
            name: buildFlatName(item.nombre, savedVariant.color),
            description: savedVariant.descripcion,
            price:
              savedVariant.precioUsd === null ? null : Number(savedVariant.precioUsd),
            imageUrl: savedVariant.imagenUrl,
            url: savedVariant.urlProducto,
          });
          await prisma.productoVariante.update({
            where: { idVariante: savedVariant.idVariante },
            data: {
              metaRetailerId: published.retailerId,
              metaMappingLocked: true,
            },
          });
          if (published.created) {
            result.meta.created += 1;
          } else {
            result.meta.mapped += 1;
          }
        } catch (error) {
          result.meta.failed += 1;
          const message =
            error instanceof Error ? error.message : 'Error desconocido publicando en Meta';
          result.meta.warnings.push(
            `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
          );
          logger.warn(
            { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
            'No se pudo publicar la variante en Meta; queda pendiente de mapeo'
          );
        }
      }

      if (writeThroughContifico && result.contifico) {
        if (savedVariant.contificoId) {
          try {
            await updateContificoProductForVariant(savedVariant.contificoId, {
              productName: item.nombre,
              sku: savedVariant.sku,
              color: savedVariant.color,
              description: savedVariant.descripcion,
              price:
                savedVariant.precioUsd === null
                  ? null
                  : Number(savedVariant.precioUsd),
              porcentajeIva: savedVariant.porcentajeIva,
              isActive: savedVariant.isActive,
              subcategoryName: item.subcategoria,
            });
            result.contifico.updated += 1;
          } catch (error) {
            result.contifico.failed += 1;
            const message =
              error instanceof Error
                ? error.message
                : 'Error desconocido actualizando Contifico';
            result.contifico.warnings.push(
              `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
            );
            logger.warn(
              { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
              'No se pudo actualizar el producto plano en Contifico'
            );
          }
        } else if (savedVariant.isActive) {
          try {
            const mapping = await createContificoProductForVariant({
              productName: item.nombre,
              variantName: savedVariant.nombre,
              sku: savedVariant.sku,
              color: savedVariant.color,
              description: savedVariant.descripcion,
              price:
                savedVariant.precioUsd === null
                  ? null
                  : Number(savedVariant.precioUsd),
              porcentajeIva: savedVariant.porcentajeIva,
              isActive: savedVariant.isActive,
              subcategoryName: item.subcategoria,
            });
            if (mapping) {
              await prisma.productoVariante.update({
                where: { idVariante: savedVariant.idVariante },
                data: mapping,
              });
              savedVariant.contificoId = mapping.contificoId;
              savedVariant.contificoSku = mapping.contificoSku;
              result.contifico.created += 1;
            } else {
              result.contifico.skipped += 1;
            }
          } catch (error) {
            result.contifico.failed += 1;
            const message =
              error instanceof Error
                ? error.message
                : 'Error desconocido creando en Contifico';
            result.contifico.warnings.push(
              `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
            );
            logger.warn(
              { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
              'No se pudo crear el producto plano en Contifico; queda pendiente de mapeo'
            );
          }
        } else {
          result.contifico.skipped += 1;
        }
      }

      if (variantIndex === 0) {
        mergePrimaryVariant = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reconciliación: desactivar SKUs que ya no existen en Contifico
// ---------------------------------------------------------------------------

export interface DeactivateProductsResult {
  variantsDeactivated: number;
  productsDeactivated: number;
}

/**
 * Desactiva variantes por SKU y, si un producto se queda sin variantes
 * activas, desactiva también el producto. Es idempotente.
 */
export async function deactivateProductsBySku(
  skus: string[]
): Promise<DeactivateProductsResult> {
  const prisma = getPrisma();
  const normalized = Array.from(
    new Set(skus.map((sku) => sku.trim()).filter((sku) => sku.length > 0))
  );
  if (normalized.length === 0) {
    return { variantsDeactivated: 0, productsDeactivated: 0 };
  }

  const estados = await resolveSyncEstados();
  const now = new Date();
  const variants = await prisma.productoVariante.findMany({
    where: { sku: { in: normalized } },
    select: { idVariante: true, idProducto: true },
  });

  if (variants.length === 0) {
    return { variantsDeactivated: 0, productsDeactivated: 0 };
  }

  await prisma.productoVariante.updateMany({
    where: { idVariante: { in: variants.map((variant) => variant.idVariante) } },
    data: { isActive: false, estadoId: estados.inactiveId, updatedAt: now },
  });

  let productsDeactivated = 0;
  const productIds = Array.from(new Set(variants.map((variant) => variant.idProducto)));
  for (const idProducto of productIds) {
    const activeVariants = await prisma.productoVariante.count({
      where: { idProducto, isActive: true },
    });
    if (activeVariants === 0) {
      const result = await prisma.producto.updateMany({
        where: { idProducto, isActive: true },
        data: { isActive: false, estadoId: estados.inactiveId, updatedAt: now },
      });
      productsDeactivated += result.count;
    }
  }

  return { variantsDeactivated: variants.length, productsDeactivated };
}
