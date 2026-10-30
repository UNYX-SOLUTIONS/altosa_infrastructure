import { env } from '../../config/env';
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
 * v2 devuelve listas paginadas como objeto ({ count, next, results }) e ignora
 * el parámetro `filtro`; v1 devuelve arrays y sí filtra por nombre/código.
 * Para listar, buscar y leer categorías usamos v1. El CRUD (GET/POST/PUT)
 * sigue usando la versión configurada en CONTIFICO_API_URL.
 */
function v1BaseUrl(): string {
  const configured = env.CONTIFICO_API_URL.replace(/\/+$/, '');
  return /\/v2$/i.test(configured) ? configured.replace(/\/v2$/i, '/v1') : configured;
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

async function fetchProductPages(estado?: 'A' | 'I'): Promise<ContificoProductDto[]> {
  const pages: ContificoProductDto[][] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await contificoGet<ContificoProductDto[]>(
      '/producto/',
      {
        page,
        ...(estado ? { estado } : {}),
      },
      v1BaseUrl()
    );

    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    const fresh = items.filter((item) => !seen.has(item.id));
    if (fresh.length === 0) {
      // La API no soporta paginación (devuelve lo mismo) o ya terminó.
      break;
    }

    for (const item of fresh) {
      seen.add(item.id);
    }
    pages.push(fresh);

    if (items.length < PAGE_SIZE) {
      break;
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
 * Obtiene el catálogo completo de Contifico. Se consultan ambos estados
 * (A/I) para que una desactivación en Contifico también se propague.
 * El dedupe por `id` tolera APIs que ignoran el parámetro `page`.
 *
 * Cache corto en memoria: health, pendientes y sync comparten la misma
 * descarga; tras crear/editar/desactivar se invalida.
 */
export async function fetchAllContificoProducts(): Promise<ContificoProductDto[]> {
  if (allProductsCache && allProductsCache.expiresAt > Date.now()) {
    return allProductsCache.promise;
  }

  const promise = (async () => {
    const [active, inactive] = await Promise.all([
      fetchProductPages('A'),
      fetchProductPages('I'),
    ]);
    return mergePages([active, inactive]);
  })();

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
  return contificoGet<ContificoProductDto>(productItemPath(id));
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
export async function searchContificoProducts(
  query: string,
  limit = 8
): Promise<ContificoProductDto[]> {
  const term = query.trim();
  if (!term) {
    return [];
  }

  const items = await contificoGet<ContificoProductDto[]>(
    '/producto/',
    {
      filtro: term,
      page: 1,
      estado: 'A',
    },
    v1BaseUrl()
  );
  if (!Array.isArray(items)) {
    return [];
  }

  const normalized = normalizeSearch(term);
  return items
    .filter((product) => {
      const sku = normalizeSearch(product.codigo ?? '');
      const name = normalizeSearch(product.nombre ?? '');
      const barcode = normalizeSearch(product.codigo_barra ?? '');
      return (
        sku.includes(normalized) ||
        name.includes(normalized) ||
        barcode.includes(normalized)
      );
    })
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
  const exact = all.find((category) => normalizeName(category.nombre) === target);
  if (exact) {
    return exact.id;
  }

  const partial = all.find((category) => normalizeName(category.nombre).includes(target));
  if (partial) {
    return partial.id;
  }

  try {
    const created = await contificoPost<ContificoCategoryDto>('/categoria/', { nombre: name.trim() });
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

export function mapContificoPrice(product: ContificoProductDto): number | null {
  return toNumber(product.pvp1);
}
