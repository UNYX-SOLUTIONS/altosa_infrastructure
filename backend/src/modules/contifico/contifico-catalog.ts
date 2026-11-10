import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';
import {
  contificoGet,
  contificoPatch,
  contificoPost,
  contificoPut,
} from './contifico-client';
import { resolveContificoSku, toNumber } from './contifico-mappers';
import type {
  ContificoCategoryDto,
  ContificoCreateProductInput,
  ContificoProductDto,
  ContificoUpdateProductInput,
} from './contifico-types';

const PAGE_SIZE = 100;
const MAX_PAGES = 2_000;

/**
 * v2 usa PUT (reemplazo completo) y rutas sin slash final; v1 usa PATCH.
 * La versión se detecta desde CONTIFICO_API_URL para permitir ambas.
 */
function isV2(): boolean {
  return /\/v2\/?$/.test(env.CONTIFICO_API_URL);
}

function productItemPath(id: string): string {
  const encoded = encodeURIComponent(id);
  return isV2() ? `/producto/${encoded}` : `/producto/${encoded}/`;
}

/**
 * v2 devuelve listas paginadas como objeto ({ count, next, results }) y
 * soporta `search` por nombre; v1 devuelve arrays. Para productos usamos v2
 * (v1 no devuelve el catálogo completo); las categorías siguen por v1.
 * El CRUD (GET/POST/PUT) usa la versión configurada en CONTIFICO_API_URL.
 */
function v1BaseUrl(): string {
  const configured = env.CONTIFICO_API_URL.replace(/\/+$/, '');
  return /\/v2$/i.test(configured) ? configured.replace(/\/v2$/i, '/v1') : configured;
}

function v2BaseUrl(): string {
  const configured = env.CONTIFICO_API_URL.replace(/\/+$/, '');
  if (/\/v2$/i.test(configured)) {
    return configured;
  }
  if (/\/v1$/i.test(configured)) {
    return configured.replace(/\/v1$/i, '/v2');
  }
  return `${configured}/v2`;
}

type ContificoProductListResponse =
  | ContificoProductDto[]
  | {
      count?: number;
      next?: string | null;
      previous?: string | null;
      results?: ContificoProductDto[];
    };

function extractProducts(response: unknown): ContificoProductDto[] {
  if (Array.isArray(response)) {
    return response as ContificoProductDto[];
  }
  if (
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { results?: unknown }).results)
  ) {
    return (response as { results: ContificoProductDto[] }).results;
  }
  return [];
}

function mergePages(pages: ContificoProductDto[][]): ContificoProductDto[] {
  const byId = new Map<string, ContificoProductDto>();
  for (const page of pages) {
    for (const product of page) {
      byId.set(product.id, product);
    }
  }
  return Array.from(byId.values());
}

function totalProductCount(response: ContificoProductListResponse): number | null {
  if (Array.isArray(response) || !response || typeof response !== 'object') {
    return null;
  }
  const count = Number((response as { count?: unknown }).count);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

async function fetchProductPages(): Promise<ContificoProductDto[]> {
  const firstResponse = await contificoGet<ContificoProductListResponse>(
    '/producto/',
    { page: 1 },
    v2BaseUrl()
  );
  const firstItems = extractProducts(firstResponse);
  if (firstItems.length === 0) {
    return [];
  }

  const count = totalProductCount(firstResponse);
  const pageSize = firstItems.length || PAGE_SIZE;
  const totalPages = count !== null
    ? Math.min(MAX_PAGES, Math.max(1, Math.ceil(count / pageSize)))
    : 1;

  const pages: ContificoProductDto[][] = [firstItems];
  const remainingPages = Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => index + 2
  );

  // La API v2 es lenta por página; se consultan en paralelo con un límite
  // conservador para que el sync/selector termine dentro del timeout.
  const CONCURRENCY = 5;
  for (let index = 0; index < remainingPages.length; index += CONCURRENCY) {
    const chunk = remainingPages.slice(index, index + CONCURRENCY);
    const responses = await Promise.all(
      chunk.map((page) =>
        contificoGet<ContificoProductListResponse>(
          '/producto/',
          { page },
          v2BaseUrl()
        )
      )
    );
    for (const response of responses) {
      pages.push(extractProducts(response));
    }
  }

  return mergePages(pages);
}

let allProductsCache: {
  expiresAt: number;
  promise: Promise<ContificoProductDto[]>;
} | null = null;

const ALL_PRODUCTS_CACHE_TTL_MS = 30_000;

export function invalidateContificoProductsCache(): void {
  allProductsCache = null;
}

/**
 * Obtiene el catálogo completo de Contifico desde v2 (incluye activos e
 * inactivos; el mapper conserva `estado` para que las desactivaciones se
 * propaguen). El dedupe por `id` tolera APIs que ignoran `page`.
 *
 * Cache corto en memoria: health, pendientes, selector y sync comparten la
 * misma descarga; tras crear/editar/desactivar se invalida.
 */
export async function fetchAllContificoProducts(): Promise<ContificoProductDto[]> {
  if (allProductsCache && allProductsCache.expiresAt > Date.now()) {
    return allProductsCache.promise;
  }

  const promise = fetchProductPages();

  allProductsCache = {
    expiresAt: Date.now() + ALL_PRODUCTS_CACHE_TTL_MS,
    promise,
  };

  try {
    return await promise;
  } catch (error) {
    allProductsCache = null;
    throw error;
  }
}

export async function fetchContificoProductById(id: string): Promise<ContificoProductDto> {
  return contificoGet<ContificoProductDto>(
    `/producto/${encodeURIComponent(id)}`,
    undefined,
    v2BaseUrl()
  );
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Búsqueda puntual para el selector del ERP. Usa el filtro de Contifico
 * (nombre/código) y vuelve a filtrar localmente para soportar mayúsculas,
 * acentos y código de barra.
 */
function matchesContificoTerm(
  product: ContificoProductDto,
  normalizedTerm: string
): boolean {
  const sku = normalizeSearch(product.codigo ?? '');
  const name = normalizeSearch(product.nombre ?? '');
  const barcode = normalizeSearch(product.codigo_barra ?? '');
  return (
    sku.includes(normalizedTerm) ||
    name.includes(normalizedTerm) ||
    barcode.includes(normalizedTerm)
  );
}

export async function searchContificoProducts(
  query: string,
  limit = 8
): Promise<ContificoProductDto[]> {
  const term = query.trim();
  if (!term) {
    return [];
  }
  const normalized = normalizeSearch(term);

  // v2 busca por nombre (no por código). Primero usamos esa búsqueda rápida
  // y, si no hay match local, caemos al catálogo completo para soportar SKU y
  // código de barra. El catálogo completo queda cacheado 30s.
  const quick = await contificoGet<ContificoProductListResponse>(
    '/producto/',
    { search: term, page: 1 },
    v2BaseUrl()
  );
  const matches = extractProducts(quick).filter((product) =>
    matchesContificoTerm(product, normalized)
  );
  if (matches.length > 0) {
    return matches.slice(0, limit);
  }

  const all = await fetchAllContificoProducts();
  return all
    .filter((product) => matchesContificoTerm(product, normalized))
    .slice(0, limit);
}

export async function fetchContificoCategories(): Promise<ContificoCategoryDto[]> {
  const categories = await contificoGet<ContificoCategoryDto[]>(
    '/categoria/',
    undefined,
    v1BaseUrl()
  );
  return Array.isArray(categories) ? categories : [];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export async function resolveContificoCategoryId(
  name: string,
  categories?: ContificoCategoryDto[]
): Promise<string | null> {
  const target = normalizeName(name);
  if (!target) {
    return null;
  }

  const all = categories ?? (await fetchContificoCategories());

  // Contifico exige cuentas contables para que una categoría sirva en
  // facturación. Se toman de env o, si no están configuradas, de una categoría
  // existente que ya esté operando (preferentemente de tipo PROD).
  const productCategories = all.filter(
    (category) => category.tipo_producto === 'PROD'
  );
  const salesReference =
    productCategories.find((category) => Boolean(category.cuenta_venta)) ??
    all.find((category) => Boolean(category.cuenta_venta));
  const inventoryReference =
    productCategories.find((category) => Boolean(category.cuenta_inventario)) ??
    all.find((category) => Boolean(category.cuenta_inventario));
  const configuredVenta = env.CONTIFICO_CUENTA_VENTA?.trim() || null;
  const configuredInventario =
    env.CONTIFICO_CUENTA_INVENTARIO?.trim() || null;
  const cuentaVenta =
    configuredVenta ?? salesReference?.cuenta_venta?.trim() ?? null;
  const cuentaInventario =
    configuredInventario ??
    inventoryReference?.cuenta_inventario?.trim() ??
    null;

  if (!cuentaVenta || !cuentaInventario) {
    logger.warn(
      { cuentaVenta, cuentaInventario, categoryName: name },
      'No se puede habilitar la categoría en Contifico: faltan cuenta_venta o cuenta_inventario. Configura CONTIFICO_CUENTA_VENTA/CONTIFICO_CUENTA_INVENTARIO o ten una categoría existente con ambas cuentas.'
    );
    return null;
  }

  const exactMatches = all.filter(
    (category) => normalizeName(category.nombre) === target
  );

  // La API v1 de Contifico no permite actualizar cuentas de una categoría
  // existente (PUT/PATCH responden 405 y POST /categoria/{id} crea otra).
  // Por eso se reutiliza solo una categoría ya habilitada; si todas las
  // coincidencias están sin cuenta de venta, se crea una nueva con cuentas.
  const healthyMatch = exactMatches.find(
    (category) =>
      category.tipo_producto === 'PROD' &&
      Boolean(category.cuenta_venta?.trim())
  );
  if (healthyMatch) {
    return healthyMatch.id;
  }
  if (exactMatches.length > 0) {
    logger.warn(
      {
        categoryName: name,
        matches: exactMatches.map((category) => ({
          id: category.id,
          cuentaVenta: category.cuenta_venta,
          cuentaInventario: category.cuenta_inventario,
          tipoProducto: category.tipo_producto,
        })),
      },
      'Las categorías existentes con ese nombre no están habilitadas para ventas; se creará una nueva categoría con cuentas contables. Las antiguas se pueden borrar en Contifico cuando queden sin productos.'
    );
  }

  try {
    const created = await contificoPost<ContificoCategoryDto>('/categoria/', {
      nombre: name.trim(),
      tipo_producto: 'PROD',
      cuenta_venta: cuentaVenta,
      cuenta_inventario: cuentaInventario,
    });
    if (!created.cuenta_venta) {
      logger.warn(
        { categoryId: created.id, categoryName: created.nombre },
        'Contifico no guardó cuenta_venta al crear la categoría.'
      );
    }
    if (!created.cuenta_inventario) {
      logger.warn(
        { categoryId: created.id, categoryName: created.nombre },
        'Contifico no guardó cuenta_inventario al crear la categoría (limitación de su API v1). Configúrala manualmente en la UI si es requerida para inventario.'
      );
    }
    return created.id;
  } catch {
    // Si la API rechaza la creación (p. ej. por permisos), el producto
    // se crea sin categoría en Contifico en lugar de fallar por completo.
    return null;
  }
}

function buildProductBody(input: ContificoCreateProductInput, categoryId: string | null) {
  const pvp1 = input.pvp1 ?? 0;
  const body: Record<string, unknown> = {
    codigo: input.codigo,
    nombre: input.nombre,
    minimo: String(input.minimo ?? 0),
    pvp1: String(pvp1),
    pvp_manual: input.pvpManual ?? pvp1 <= 0,
    estado: input.estado ?? 'A',
    tipo: input.tipo ?? 'PRO',
    tipo_producto: input.tipoProducto ?? 'SIM',
    para_pos: true,
  };

  if (input.descripcion) body.descripcion = input.descripcion;
  if (categoryId) body.categoria_id = categoryId;
  if (input.codigoBarra) body.codigo_barra = input.codigoBarra;
  if (input.porcentajeIva !== undefined && input.porcentajeIva !== null) {
    body.porcentaje_iva = input.porcentajeIva;
  }

  return body;
}

export async function createContificoProduct(
  input: ContificoCreateProductInput
): Promise<ContificoProductDto> {
  if (input.codigo.trim().length === 0) {
    throw new HttpError(422, 'El SKU/código es obligatorio para crear el producto en Contifico.', 'CONTIFICO_SKU_REQUIRED');
  }
  if (input.codigo.length > 25) {
    throw new HttpError(
      422,
      'El código de Contifico admite máximo 25 caracteres. Ajusta el SKU del producto.',
      'CONTIFICO_SKU_TOO_LONG'
    );
  }

  const categoryId = input.categoriaNombre
    ? await resolveContificoCategoryId(input.categoriaNombre)
    : null;

  const created = await contificoPost<ContificoProductDto>(
    '/producto/',
    buildProductBody(input, categoryId)
  );
  invalidateContificoProductsCache();

  if (created && typeof created.id === 'string') {
    return created;
  }

  const products = await fetchAllContificoProducts();
  const found = products.find((product) => resolveContificoSku(product) === input.codigo);
  if (!found) {
    throw new HttpError(
      502,
      'Contifico no devolvió el producto creado.',
      'CONTIFICO_CREATE_NO_RESPONSE'
    );
  }
  return found;
}

/**
 * v2 exige PUT con los campos mínimos (codigo, nombre, minimo, pvp1, estado)
 * y es un reemplazo completo. Reconstruimos el producto actual y aplicamos
 * solo los cambios, para no borrar precios, cuentas, marca, etc.
 */
function buildFullUpdateBody(
  current: ContificoProductDto,
  input: ContificoUpdateProductInput,
  categoryId: string | null
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    codigo: current.codigo ?? '',
    nombre: input.nombre ?? current.nombre,
    descripcion: input.descripcion ?? current.descripcion ?? '',
    minimo: String(input.minimo ?? current.minimo ?? 0),
    pvp1: String(input.pvp1 ?? current.pvp1 ?? 0),
    pvp_manual: input.pvpManual ?? current.pvp_manual ?? false,
    estado: input.estado ?? current.estado ?? 'A',
    tipo: current.tipo ?? 'PRO',
    tipo_producto: current.tipo_producto ?? 'SIM',
    para_pos: current.para_pos ?? true,
    porcentaje_iva: input.porcentajeIva ?? current.porcentaje_iva ?? 0,
    codigo_barra: input.codigoBarra ?? current.codigo_barra ?? '',
  };

  const resolvedCategoryId = categoryId ?? current.categoria_id;
  if (resolvedCategoryId) body.categoria_id = resolvedCategoryId;
  if (current.imagen !== null && current.imagen !== undefined && current.imagen !== '') {
    // Se reenvía la imagen actual para que el PUT no la borre. No se
    // actualiza desde el ERP porque v2 espera un objeto Foto.
    body.imagen = current.imagen;
  }
  if (current.cantidad_stock !== null && current.cantidad_stock !== undefined) {
    // Preserva el stock; el inventario se mueve con movimientos, no desde
    // la edición del producto.
    body.cantidad_stock = current.cantidad_stock;
  }
  if (current.pvp2 !== null && current.pvp2 !== undefined) body.pvp2 = current.pvp2;
  if (current.pvp3 !== null && current.pvp3 !== undefined) body.pvp3 = current.pvp3;
  if (current.pvp4 !== null && current.pvp4 !== undefined) body.pvp4 = current.pvp4;
  if (current.marca_id) body.marca_id = current.marca_id;
  if (current.cuenta_venta_id) body.cuenta_venta_id = current.cuenta_venta_id;
  if (current.cuenta_compra_id) body.cuenta_compra_id = current.cuenta_compra_id;
  if (current.cuenta_costo_id) body.cuenta_costo_id = current.cuenta_costo_id;
  if (current.costo_maximo !== null && current.costo_maximo !== undefined) {
    body.costo_maximo = current.costo_maximo;
  }
  if (current.codigo_proveedor) body.codigo_proveedor = current.codigo_proveedor;
  if (current.lead_time !== null && current.lead_time !== undefined) {
    body.lead_time = current.lead_time;
  }
  if (current.generacion_automatica !== null && current.generacion_automatica !== undefined) {
    body.generacion_automatica = current.generacion_automatica;
  }
  if (current.id_integracion_proveedor) {
    body.id_integracion_proveedor = current.id_integracion_proveedor;
  }
  if (current.unidad) body.unidad = current.unidad;
  if (current.personalizado1) body.personalizado1 = current.personalizado1;
  if (current.personalizado2) body.personalizado2 = current.personalizado2;
  if (current.pvp_peso !== null && current.pvp_peso !== undefined) {
    body.pvp_peso = current.pvp_peso;
  }
  if (current.peso_desde !== null && current.peso_desde !== undefined) {
    body.peso_desde = current.peso_desde;
  }
  if (current.peso_hasta !== null && current.peso_hasta !== undefined) {
    body.peso_hasta = current.peso_hasta;
  }

  return body;
}

export async function updateContificoProduct(
  id: string,
  input: ContificoUpdateProductInput
): Promise<ContificoProductDto> {
  const categoryId = input.categoriaNombre
    ? await resolveContificoCategoryId(input.categoriaNombre)
    : null;

  if (isV2()) {
    const current = await fetchContificoProductById(id);
    const body = buildFullUpdateBody(current, input, categoryId);
    const updated = await contificoPut<ContificoProductDto>(productItemPath(id), body);
    if (updated && typeof updated.id === 'string') {
      return updated;
    }
    return fetchContificoProductById(id);
  }

  const body: Record<string, unknown> = {};
  if (input.nombre !== undefined) body.nombre = input.nombre;
  if (input.descripcion !== undefined) body.descripcion = input.descripcion;
  if (input.estado !== undefined) body.estado = input.estado;
  if (input.codigoBarra !== undefined) body.codigo_barra = input.codigoBarra;
  if (input.porcentajeIva !== undefined) body.porcentaje_iva = input.porcentajeIva;
  if (input.minimo !== undefined) body.minimo = String(input.minimo ?? 0);
  if (input.pvp1 !== undefined) body.pvp1 = String(input.pvp1 ?? 0);
  if (input.pvpManual !== undefined) body.pvp_manual = input.pvpManual;
  if (categoryId) body.categoria_id = categoryId;

  const updated = await contificoPatch<ContificoProductDto>(productItemPath(id), body);
  invalidateContificoProductsCache();
  if (updated && typeof updated.id === 'string') {
    return updated;
  }
  return fetchContificoProductById(id);
}

export async function deactivateContificoProduct(id: string): Promise<ContificoProductDto> {
  return updateContificoProduct(id, { estado: 'I' });
}

/**
 * Borra el producto en Contifico. Si la API rechaza el DELETE (por permisos
 * o porque la versión no lo soporta), cae a desactivarlo, que es el equivalente
 * funcional para el catálogo.
 */
export function mapContificoPrice(product: ContificoProductDto): number | null {
  return toNumber(product.pvp1);
}
