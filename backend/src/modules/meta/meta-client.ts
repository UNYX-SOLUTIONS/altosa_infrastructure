import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';

const META_FIELDS =
  'id,retailer_id,name,availability,visibility,price,image_url,url,custom_label_0,custom_label_1';
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface MetaCatalogItem {
  id: string | null;
  retailerId: string;
  name: string;
  imageUrl: string | null;
  price: string | null;
  availability: string | null;
  visibility: string | null;
  url: string | null;
}

interface MetaProductRaw {
  id?: unknown;
  retailer_id?: unknown;
  name?: unknown;
  image_url?: unknown;
  price?: unknown;
  availability?: unknown;
  visibility?: unknown;
  url?: unknown;
}

interface CacheEntry {
  expiresAt: number;
  items: MetaCatalogItem[];
}

let cache: CacheEntry | null = null;
let inFlight: Promise<MetaCatalogItem[]> | null = null;

export function isMetaConfigured(): boolean {
  return Boolean(env.META_CATALOG_ID && env.META_ACCESS_TOKEN);
}

function requireConfig(): { catalogId: string; token: string; version: string } {
  if (!env.META_CATALOG_ID || !env.META_ACCESS_TOKEN) {
    throw new HttpError(
      503,
      'El catálogo de Meta no está configurado (faltan META_CATALOG_ID y META_ACCESS_TOKEN).',
      'META_NOT_CONFIGURED'
    );
  }
  return {
    catalogId: env.META_CATALOG_ID,
    token: env.META_ACCESS_TOKEN,
    version: env.META_API_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toMetaItem(value: unknown): MetaCatalogItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const raw = value as MetaProductRaw;
  const retailerId = readString(raw.retailer_id);
  if (!retailerId) {
    return null;
  }
  return {
    id: readString(raw.id),
    retailerId,
    name: readString(raw.name) ?? '',
    imageUrl: readString(raw.image_url),
    price: readString(raw.price),
    availability: readString(raw.availability),
    visibility: readString(raw.visibility),
    url: readString(raw.url),
  };
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeRetailerId(value: string): string {
  return normalizeText(value);
}

function normalizeExactRetailerId(value: string): string {
  return value.trim().toLowerCase();
}

function compactRetailerId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function validateGraphUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(
      502,
      'Meta devolvió una URL de paginación inválida.',
      'META_API_ERROR'
    );
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw new HttpError(
      502,
      'Meta devolvió una URL de paginación inesperada.',
      'META_API_ERROR'
    );
  }
  url.searchParams.delete('access_token');
  return url.toString();
}

async function fetchPage(url: string, token: string): Promise<{
  items: MetaCatalogItem[];
  next: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(validateGraphUrl(url), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, endpoint: 'meta.catalog.products' },
        'Meta Graph API respondió con error'
      );
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          'Meta rechazó el token o la integración no tiene permisos sobre el catálogo.',
          'META_API_ERROR'
        );
      }
      if (response.status === 429) {
        throw new HttpError(
          502,
          'Meta limitó temporalmente las consultas al catálogo. Intenta de nuevo en unos minutos.',
          'META_API_ERROR'
        );
      }
      throw new HttpError(
        502,
        `Meta respondió con estado ${response.status} al consultar el catálogo.`,
        'META_API_ERROR'
      );
    }

    const body = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new HttpError(
        502,
        'Meta devolvió una respuesta inesperada al consultar el catálogo.',
        'META_API_ERROR'
      );
    }

    const items = body.data
      .map(toMetaItem)
      .filter((item): item is MetaCatalogItem => item !== null);

    const paging = isRecord(body.paging) ? body.paging : null;
    const next = paging && typeof paging.next === 'string' ? paging.next : null;

    return { items, next };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(
        502,
        'Tiempo de espera agotado consultando el catálogo de Meta.',
        'META_API_ERROR'
      );
    }
    logger.warn(
      { endpoint: 'meta.catalog.products' },
      'No se pudo conectar con Meta Graph API'
    );
    throw new HttpError(
      502,
      'No se pudo conectar con Meta para consultar el catálogo.',
      'META_API_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCatalog(): Promise<MetaCatalogItem[]> {
  const { catalogId, token, version } = requireConfig();
  let nextUrl: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(catalogId)}/products` +
    `?fields=${encodeURIComponent(META_FIELDS)}&limit=${PAGE_LIMIT}`;
  const items: MetaCatalogItem[] = [];
  let pages = 0;

  while (nextUrl) {
    if (++pages > MAX_PAGES) {
      throw new HttpError(
        502,
        `Se superó el límite de ${MAX_PAGES} páginas del catálogo de Meta.`,
        'META_API_ERROR'
      );
    }
    const page = await fetchPage(nextUrl, token);
    items.push(...page.items);
    nextUrl = page.next;
    if (!nextUrl || page.items.length === 0) {
      break;
    }
  }

  return items;
}

export async function getMetaCatalog(): Promise<MetaCatalogItem[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.items;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchCatalog()
    .then((items) => {
      cache = { expiresAt: Date.now() + CACHE_TTL_MS, items };
      return items;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export async function findMetaCatalogItem(
  retailerId: string
): Promise<MetaCatalogItem | null> {
  const target = normalizeExactRetailerId(retailerId);
  if (!target) {
    return null;
  }
  const items = await getMetaCatalog();
  return (
    items.find((item) => normalizeExactRetailerId(item.retailerId) === target) ?? null
  );
}

export async function searchMetaCatalog(
  query: string,
  limit: number
): Promise<MetaCatalogItem[]> {  const items = await getMetaCatalog();
  const retailerTerm = normalizeRetailerId(query);
  const exactRetailerTerm = normalizeExactRetailerId(query);
  const compactRetailerTerm = compactRetailerId(query);
  const nameTerm = normalizeText(query);
  if (!retailerTerm && !nameTerm) {
    return [];
  }

  const exact: MetaCatalogItem[] = [];
  const byRetailer: MetaCatalogItem[] = [];
  const byNamePrefix: MetaCatalogItem[] = [];
  const byName: MetaCatalogItem[] = [];
  const seen = new Set<string>();

  const pushUnique = (target: MetaCatalogItem[], item: MetaCatalogItem): void => {
    const key = item.retailerId.trim().toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    target.push(item);
  };

  for (const item of items) {
    const itemRetailer = normalizeRetailerId(item.retailerId);
    const itemExactRetailer = normalizeExactRetailerId(item.retailerId);
    const itemCompactRetailer = compactRetailerId(item.retailerId);
    const itemName = normalizeText(item.name);
    if (retailerTerm && itemExactRetailer === exactRetailerTerm) {
      pushUnique(exact, item);
      continue;
    }
    if (
      retailerTerm &&
      (itemRetailer.includes(retailerTerm) ||
        (compactRetailerTerm && itemCompactRetailer.includes(compactRetailerTerm)))
    ) {
      pushUnique(byRetailer, item);
      continue;
    }
    if (nameTerm && itemName.startsWith(nameTerm)) {
      pushUnique(byNamePrefix, item);
      continue;
    }
    if (nameTerm && itemName.includes(nameTerm)) {
      pushUnique(byName, item);
    }
  }

  return [...exact, ...byRetailer, ...byNamePrefix, ...byName].slice(0, limit);
}

export interface MetaCatalogCreateInput {
  retailerId: string;
  name: string;
  description?: string | null;
  price: number;
  imageUrl: string;
  url?: string | null;
}

export interface MetaCatalogCreateResult {
  retailerId: string;
  id: string | null;
  created: true;
}

/**
 * Publica un ítem plano en el catálogo de Meta. Usa `retailer_id` como clave
 * estable: si Meta ya lo tiene, el llamador debe haberlo detectado antes con
 * findMetaCatalogItem para no duplicar.
 */
export async function createMetaCatalogItem(
  input: MetaCatalogCreateInput
): Promise<MetaCatalogCreateResult> {
  const { catalogId, token, version } = requireConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(
    catalogId
  )}/products`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        retailer_id: input.retailerId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        price: `${input.price.toFixed(2)} USD`,
        currency: 'USD',
        availability: 'in stock',
        condition: 'new',
        image_url: input.imageUrl,
        ...(input.url ? { url: input.url } : {}),
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      const metaMessage =
        isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : null;
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          'Meta rechazó el token o la integración no tiene permiso de escritura (catalog_management) sobre el catálogo.',
          'META_WRITE_FORBIDDEN'
        );
      }
      if (response.status === 429) {
        throw new HttpError(
          502,
          'Meta limitó temporalmente la creación de ítems. Intenta de nuevo en unos minutos.',
          'META_API_ERROR'
        );
      }
      throw new HttpError(
        502,
        metaMessage
          ? `Meta rechazó la publicación: ${metaMessage}`
          : `Meta respondió con estado ${response.status} al publicar el producto.`,
        'META_API_ERROR'
      );
    }

    // La escritura invalida el catálogo cacheado para que el buscador y la
    // bandeja de pendientes vean el nuevo ítem de inmediato.
    cache = null;

    return {
      retailerId: input.retailerId,
      id: isRecord(body) && typeof body.id === 'string' ? body.id : null,
      created: true,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(
        502,
        'Tiempo de espera agotado publicando el producto en Meta.',
        'META_API_ERROR'
      );
    }
    logger.warn({ endpoint: 'meta.catalog.create' }, 'No se pudo conectar con Meta Graph API');
    throw new HttpError(
      502,
      'No se pudo conectar con Meta para publicar el producto.',
      'META_API_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface MetaCatalogUpdateInput {
  name?: string;
  description?: string | null;
  price?: number | null;
  imageUrl?: string | null;
  url?: string | null;
  availability?: string;
}

/**
 * Actualiza un ítem plano existente del catálogo. Requiere el id del ítem
 * (no el retailer_id), que se obtiene con findMetaCatalogItem.
 */
export async function updateMetaCatalogItem(
  itemId: string,
  input: MetaCatalogUpdateInput
): Promise<void> {
  const { token, version } = requireConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(itemId)}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description ?? '' }
          : {}),
        ...(input.price !== undefined && input.price !== null
          ? { price: `${input.price.toFixed(2)} USD`, currency: 'USD' }
          : {}),
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.availability ? { availability: input.availability } : {}),
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const metaMessage =
        isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : null;
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          'Meta rechazó el token o la integración no tiene permiso de escritura (catalog_management) sobre el catálogo.',
          'META_WRITE_FORBIDDEN'
        );
      }
      throw new HttpError(
        502,
        metaMessage
          ? `Meta rechazó la actualización: ${metaMessage}`
          : `Meta respondió con estado ${response.status} al actualizar el producto.`,
        'META_API_ERROR'
      );
    }

    cache = null;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(
        502,
        'Tiempo de espera agotado actualizando el producto en Meta.',
        'META_API_ERROR'
      );
    }
    logger.warn({ endpoint: 'meta.catalog.update' }, 'No se pudo conectar con Meta Graph API');
    throw new HttpError(
      502,
      'No se pudo conectar con Meta para actualizar el producto.',
      'META_API_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Elimina un ítem plano del catálogo. Un 404 se trata como “ya eliminado”.
 */
export async function deleteMetaCatalogItem(itemId: string): Promise<void> {
  const { token, version } = requireConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(itemId)}`;

  try {
    const response = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      cache = null;
      return;
    }

    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const metaMessage =
        isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : null;
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          'Meta rechazó el token o la integración no tiene permiso de escritura (catalog_management) sobre el catálogo.',
          'META_WRITE_FORBIDDEN'
        );
      }
      throw new HttpError(
        502,
        metaMessage
          ? `Meta rechazó la eliminación: ${metaMessage}`
          : `Meta respondió con estado ${response.status} al eliminar el producto.`,
        'META_API_ERROR'
      );
    }

    cache = null;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(
        502,
        'Tiempo de espera agotado eliminando el producto en Meta.',
        'META_API_ERROR'
      );
    }
    logger.warn({ endpoint: 'meta.catalog.delete' }, 'No se pudo conectar con Meta Graph API');
    throw new HttpError(
      502,
      'No se pudo conectar con Meta para eliminar el producto.',
      'META_API_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}
