/**
 * Reconciliación Meta -> Altosa por producto y variante.
 *
 * No usa SKU como entrada: Meta no trae SKU. Usa:
 *   - nombre base del producto (sin genéricos ni color)
 *   - familia/tono de color de la variante
 *   - código de color en el SKU como apoyo (LGR, OSC, BE, etc.)
 *
 * Acciones:
 *   - map: existe producto y variante del color -> escribe meta_retailer_id.
 *   - create_variant: existe producto, no el color -> crea variante inactiva.
 *   - create_product: no existe producto base -> crea producto+variante inactivos.
 *   - already_mapped / conflict / ambiguous / skipped.
 *
 * Uso:
 *   pnpm reconcile:meta-variants -- --report data/meta-variant-report.csv
 *   pnpm reconcile:meta-variants -- --report data/meta-variant-report.csv --apply
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disconnectPrisma, getPrisma } from '../config/prisma';

const META_FIELDS =
  'retailer_id,name,availability,visibility,price,image_url,url,description,custom_label_0,custom_label_1';
const META_PAGE_LIMIT = 100;
const META_MAX_PAGES = 100;
const META_TIMEOUT_MS = 30_000;

const GENERIC_WORDS = new Set([
  'silla', 'sillon', 'taburete', 'base', 'mesa', 'escritorio', 'butaca', 'banco',
  'puff', 'sofa', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'con',
  'para', 'en', 'por', 'sin', 'new', 'tapizada', 'tapizado', 'oficina', 'plastica',
  'acrilica', 'comedor', 'exterior', 'evento', 'the', 'coleccion', 'linea',
]);

const COLOR_WORDS = new Set([
  'blanco', 'blanca', 'negro', 'negra', 'gris', 'beige', 'azul', 'verde', 'rojo',
  'roja', 'amarillo', 'amarilla', 'mostaza', 'taupe', 'cafe', 'marino', 'salmon',
  'naranja', 'rosado', 'rosa', 'vino', 'morado', 'lila', 'crema', 'dorado',
  'dorada', 'plateado', 'cromado', 'natural', 'ladrillo', 'terracota',
  'chocolate', 'moka', 'camel', 'hueso', 'marfil', 'arena', 'piedra', 'grafito',
  'plomo', 'bronce', 'oro', 'plata', 'transparente', 'humo', 'oscuro', 'oscura',
  'claro', 'clara', 'light', 'dark', 'medio', 'media',
]);

const MATERIAL_WORDS = new Set([
  'cuerina', 'cuero', 'lino', 'velvet', 'terciopelo', 'metal', 'madera', 'acero',
  'cromo', 'espuma', 'tela', 'polipiel', 'piel', 'sintetico', 'sintetica',
  'aluminio', 'hierro', 'plastico', 'plastica', 'rattan', 'ratan', 'mimbre',
  'cristal', 'vidrio', 'acrilico', 'acrilica', 'melamina', 'mdf',
]);

const SHADE_WORDS: Record<string, 'claro' | 'oscuro'> = {
  claro: 'claro', clara: 'claro', light: 'claro',
  oscuro: 'oscuro', oscura: 'oscuro', dark: 'oscuro',
};

interface MetaItem {
  retailerId: string;
  name: string;
  availability: string | null;
  visibility: string | null;
  price: string | null;
  imageUrl: string | null;
  url: string | null;
  description: string | null;
  color: ColorInfo;
}

interface ColorInfo {
  full: string;
  family: string | null;
  shade: 'claro' | 'oscuro' | null;
}

interface VariantRow {
  idVariante: number;
  idProducto: number;
  sku: string | null;
  color: string | null;
  material: string | null;
  descripcion: string | null;
  isActive: boolean;
  metaRetailerId: string | null;
  metaMappingLocked: boolean;
  precioUsd: number | null;
  colorInfo: ColorInfo;
  materialText: string;
}

interface ProductRow {
  idProducto: number;
  nombre: string;
  isActive: boolean;
  baseKey: string;
  baseTokens: string[];
  variants: VariantRow[];
}

type Action =
  | 'map'
  | 'create_variant'
  | 'create_product'
  | 'already_mapped'
  | 'conflict'
  | 'ambiguous_product'
  | 'ambiguous_color'
  | 'no_color'
  | 'skipped';

interface Decision {
  item: MetaItem;
  action: Action;
  product: ProductRow | null;
  variant: VariantRow | null;
  detail: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readOption(name: string): string | undefined {
  const args = process.argv.slice(2);
  const equalsArg = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equalsArg) {
    return equalsArg.slice(`--${name}=`.length);
  }
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    return args[index + 1];
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  return normalizeText(value).split(' ').filter((word) => word.length > 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function colorInfo(value: string | null): ColorInfo {
  const full = normalizeText(value ?? '');
  const tokens = full ? full.split(' ') : [];
  const family = tokens.find((token) => COLOR_WORDS.has(token) && !SHADE_WORDS[token]) ?? null;
  const shade = tokens.map((token) => SHADE_WORDS[token]).find(Boolean) ?? null;
  return { full, family, shade };
}

function extractMetaColor(name: string): ColorInfo {
  const info = colorInfo(name);
  const phrase = info.family
    ? [info.family, info.shade].filter(Boolean).join(' ')
    : '';
  return { full: phrase, family: info.family, shade: info.shade };
}

function baseTokens(value: string): string[] {
  return words(value).filter(
    (word) =>
      !GENERIC_WORDS.has(word) &&
      !COLOR_WORDS.has(word) &&
      !MATERIAL_WORDS.has(word) &&
      !SHADE_WORDS[word]
  );
}

function baseKey(tokens: string[]): string {
  return [...new Set(tokens)].sort().join('|');
}

function removeColorWords(name: string): string {
  const original = name.trim().replace(/\s+/g, ' ');
  const kept = original
    .split(' ')
    .filter((word) => {
      const normalized = normalizeText(word);
      return (
        !COLOR_WORDS.has(normalized) &&
        !MATERIAL_WORDS.has(normalized) &&
        !SHADE_WORDS[normalized]
      );
    });
  const result = kept.join(' ').trim();
  return result || original;
}

function skuColorHint(sku: string | null): 'claro' | 'oscuro' | null {
  if (!sku) {
    return null;
  }
  const value = sku.toUpperCase();
  if (/LGR|LIG|LIGHT|CLARO|CLR/.test(value)) {
    return 'claro';
  }
  if (/OSC|DARK|DGR/.test(value)) {
    return 'oscuro';
  }
  return null;
}

function colorScore(item: MetaItem, variant: VariantRow): number {
  const meta = item.color;
  const v = variant.colorInfo;
  let score = 0;
  if (meta.full && v.full && meta.full === v.full) {
    score = 1;
  } else if (meta.family && v.family && meta.family === v.family) {
    if (meta.shade && v.shade) {
      score = meta.shade === v.shade ? 0.98 : 0;
    } else if (meta.shade && !v.shade) {
      const hint = skuColorHint(variant.sku);
      if (hint === meta.shade) {
        score = 0.95;
      } else if (hint && hint !== meta.shade) {
        score = 0;
      } else {
        score = 0.75;
      }
    } else if (!meta.shade && v.shade) {
      score = 0.7;
    } else {
      score = 0.9;
    }
  } else if (meta.full && v.full && (meta.full.includes(v.full) || v.full.includes(meta.full))) {
    score = 0.65;
  }

  if (score <= 0) {
    return score;
  }

  const metaMaterial = words(item.name).filter((word) => MATERIAL_WORDS.has(word));
  if (metaMaterial.length > 0) {
    const materialMatch = metaMaterial.some((word) => variant.materialText.includes(word));
    score = materialMatch ? Math.min(1, score + 0.12) : Math.max(0, score - 0.15);
  }
  return score;
}

function parsePrice(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = value.replace(/,/g, '.').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toMetaItem(value: unknown): MetaItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const retailerId = readString(value.retailer_id) ?? readString(value.retailerId);
  if (!retailerId) {
    return null;
  }
  const name = readString(value.name) ?? '';
  return {
    retailerId,
    name,
    availability: readString(value.availability),
    visibility: readString(value.visibility),
    price: readString(value.price),
    imageUrl: readString(value.image_url) ?? readString(value.imageUrl),
    url: readString(value.url),
    description: readString(value.description),
    color: extractMetaColor(name),
  };
}

function validateGraphUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Meta devolvió una URL de paginación inválida.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw new Error('Meta devolvió una URL de paginación inesperada.');
  }
  url.searchParams.delete('access_token');
  return url.toString();
}

async function fetchMetaCatalog(): Promise<MetaItem[]> {
  const catalogId = process.env.META_CATALOG_ID?.trim();
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const version = process.env.META_API_VERSION?.trim() || 'v26.0';
  if (!catalogId || !token) {
    fail('Faltan META_CATALOG_ID y/o META_ACCESS_TOKEN.');
  }

  let nextUrl: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(catalogId)}/products` +
    `?fields=${encodeURIComponent(META_FIELDS)}&limit=${META_PAGE_LIMIT}`;
  const items: MetaItem[] = [];
  let pages = 0;

  while (nextUrl) {
    if (++pages > META_MAX_PAGES) {
      fail(`Se superó el límite de ${META_MAX_PAGES} páginas de Meta.`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(validateGraphUrl(nextUrl), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      fail(
        error instanceof Error && error.name === 'AbortError'
          ? 'Timeout consultando Meta.'
          : 'No se pudo conectar con Meta.'
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      fail(`Meta respondió HTTP ${response.status}.`);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !Array.isArray(body.data)) {
      fail('Meta devolvió una respuesta inesperada.');
    }
    for (const raw of body.data) {
      const item = toMetaItem(raw);
      if (item) {
        items.push(item);
      }
    }
    nextUrl =
      isRecord(body.paging) && typeof body.paging.next === 'string'
        ? body.paging.next
        : null;
  }
  return items;
}

async function loadProducts(): Promise<ProductRow[]> {
  const rows = await getPrisma().producto.findMany({
    select: {
      idProducto: true,
      producto: true,
      isActive: true,
      variants: {
        select: {
          idVariante: true,
          idProducto: true,
          sku: true,
          color: true,
          material: true,
          descripcion: true,
          isActive: true,
          metaRetailerId: true,
          metaMappingLocked: true,
          precioUsd: true,
        },
        orderBy: { idVariante: 'asc' },
      },
    },
    orderBy: { idProducto: 'asc' },
  });

  return rows.map((row) => {
    const tokens = baseTokens(row.producto);
    return {
      idProducto: row.idProducto,
      nombre: row.producto,
      isActive: row.isActive,
      baseTokens: tokens,
      baseKey: baseKey(tokens),
      variants: row.variants.map((variant) => ({
        idVariante: variant.idVariante,
        idProducto: variant.idProducto,
        sku: variant.sku,
        color: variant.color,
        material: variant.material,
        descripcion: variant.descripcion,
        isActive: variant.isActive,
        metaRetailerId: variant.metaRetailerId,
        metaMappingLocked: variant.metaMappingLocked,
        precioUsd: variant.precioUsd === null ? null : Number(variant.precioUsd),
        colorInfo: colorInfo(variant.color),
        materialText: normalizeText(
          [variant.color, variant.material, variant.descripcion].filter(Boolean).join(' ')
        ),
      })),
    };
  });
}

function findProductCandidates(item: MetaItem, products: ProductRow[]): ProductRow[] {
  const metaTokens = baseTokens(item.name);
  if (metaTokens.length === 0) {
    return [];
  }
  const key = baseKey(metaTokens);
  return products.filter((product) => product.baseKey === key);
}

function pickProduct(candidates: ProductRow[], item: MetaItem): ProductRow | null {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }

  const withColor = candidates
    .map((product) => ({
      product,
      bestColor: Math.max(0, ...product.variants.map((variant) => colorScore(item, variant))),
    }))
    .sort((a, b) => b.bestColor - a.bestColor || Number(b.product.isActive) - Number(a.product.isActive) || a.product.idProducto - b.product.idProducto);

  return withColor[0]?.product ?? null;
}

function chooseVariant(product: ProductRow, item: MetaItem): {
  variant: VariantRow | null;
  action: 'map' | 'create_variant' | 'ambiguous_color' | 'no_color';
  detail: string;
} {
  if (!item.color.family && !item.color.full) {
    if (product.variants.length === 1) {
      return { variant: product.variants[0]!, action: 'map', detail: 'producto con una sola variante' };
    }
    return { variant: null, action: 'no_color', detail: 'Meta no trae color y el producto tiene varias variantes' };
  }

  const scored = product.variants
    .map((variant) => ({ variant, score: colorScore(item, variant) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.variant.idVariante - b.variant.idVariante);

  if (scored.length === 0) {
    return { variant: null, action: 'create_variant', detail: 'no existe variante con ese color' };
  }

  const top = scored[0]!;
  const second = scored[1];
  const tie = second !== undefined && Math.abs(second.score - top.score) < 0.001;
  if (tie) {
    return {
      variant: top.variant,
      action: 'ambiguous_color',
      detail: `varias variantes con el mismo color (${top.variant.sku ?? top.variant.idVariante})`,
    };
  }
  if (top.score < 0.7) {
    return { variant: null, action: 'create_variant', detail: `color sin match suficiente (${top.score.toFixed(2)})` };
  }
  return { variant: top.variant, action: 'map', detail: `color match ${top.score.toFixed(2)}` };
}

async function ensureMetaSubcategory(): Promise<number> {
  const prisma = getPrisma();
  let category = await prisma.categoria.findFirst({
    where: { nombre: { equals: 'Meta', mode: 'insensitive' } },
    select: { id: true },
  });
  if (!category) {
    category = await prisma.categoria.create({
      data: { nombre: 'Meta', updatedAt: new Date() },
      select: { id: true },
    });
  }
  let subcategory = await prisma.subcategoria.findFirst({
    where: {
      idCategoria: category.id,
      nombre: { equals: 'Catálogo Meta', mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (!subcategory) {
    subcategory = await prisma.subcategoria.create({
      data: {
        idCategoria: category.id,
        nombre: 'Catálogo Meta',
        updatedAt: new Date(),
      },
      select: { id: true },
    });
  }
  return subcategory.id;
}

async function inactiveEstadoId(): Promise<number> {
  const prisma = getPrisma();
  const inactive = await prisma.estado.findFirst({
    where: {
      OR: [
        { estado: { contains: 'inactiv', mode: 'insensitive' } },
        { estado: { contains: 'desactiv', mode: 'insensitive' } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (inactive) {
    return inactive.id;
  }
  const fallback = await prisma.estado.findUnique({ where: { id: 2 }, select: { id: true } });
  if (!fallback) {
    fail('No se encontró el estado inactivo en la tabla estados.');
  }
  return fallback.id;
}

function uniqueSku(retailerId: string): string {
  return `META-${retailerId}`;
}

async function createVariant(product: ProductRow, item: MetaItem, estadoId: number): Promise<VariantRow | null> {
  const prisma = getPrisma();
  const now = new Date();
  const price = parsePrice(item.price);
  const color = item.color.full
    ? item.color.full.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'Estándar';
  const materialWords = words(item.name).filter((word) => MATERIAL_WORDS.has(word));
  const material = materialWords.length > 0 ? materialWords.join(' ') : null;
  const sku = uniqueSku(item.retailerId);

  try {
    const created = await prisma.productoVariante.create({
      data: {
        idProducto: product.idProducto,
        sku,
        color,
        material,
        descripcion: item.description ?? item.name,
        precioUsd: price,
        imagenUrl: item.imageUrl,
        urlProducto: item.url,
        estadoId,
        isActive: false,
        metaRetailerId: item.retailerId,
        metaMappingLocked: true,
        especificacionesAdicionales: JSON.stringify({
          availability: item.availability,
          visibility: item.visibility,
          source: 'meta',
        }),
        createdAt: now,
        updatedAt: now,
      },
      select: {
        idVariante: true,
        idProducto: true,
        sku: true,
        color: true,
        material: true,
        descripcion: true,
        isActive: true,
        metaRetailerId: true,
        metaMappingLocked: true,
        precioUsd: true,
      },
    });
    return {
      idVariante: created.idVariante,
      idProducto: created.idProducto,
      sku: created.sku,
      color: created.color,
      material: created.material,
      descripcion: created.descripcion,
      isActive: created.isActive,
      metaRetailerId: created.metaRetailerId,
      metaMappingLocked: created.metaMappingLocked,
      precioUsd: created.precioUsd === null ? null : Number(created.precioUsd),
      colorInfo: colorInfo(created.color),
      materialText: normalizeText(
        [created.color, created.material, created.descripcion].filter(Boolean).join(' ')
      ),
    };
  } catch (error) {
    console.error(`No se pudo crear la variante ${item.retailerId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function createProductWithVariant(item: MetaItem, estadoId: number): Promise<ProductRow | null> {
  const prisma = getPrisma();
  const now = new Date();
  const subcategoryId = await ensureMetaSubcategory();
  const name = removeColorWords(item.name);

  try {
    const product = await prisma.producto.create({
      data: {
        idSubCategoria: subcategoryId,
        producto: name,
        descripcion: item.description ?? null,
        usoRecomendado: null,
        estadoId,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      },
      select: { idProducto: true },
    });

    const productRow: ProductRow = {
      idProducto: product.idProducto,
      nombre: name,
      isActive: false,
      baseTokens: baseTokens(name),
      baseKey: baseKey(baseTokens(name)),
      variants: [],
    };
    const variant = await createVariant(productRow, item, estadoId);
    if (!variant) {
      return null;
    }

    return {
      ...productRow,
      variants: [variant],
    };
  } catch (error) {
    console.error(`No se pudo crear el producto ${item.retailerId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadMetaItems(fileArg?: string): Promise<MetaItem[]> {
  if (!fileArg) {
    return fetchMetaCatalog();
  }
  const absolutePath = resolve(process.cwd(), fileArg);
  const raw = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.items)
      ? raw.items
      : null;
  if (!items) {
    fail('El archivo Meta debe ser un arreglo o un objeto con "items".');
  }
  return items
    .map(toMetaItem)
    .filter((item): item is MetaItem => item !== null);
}

async function main(): Promise<void> {
  const reportPath = readOption('report') ?? 'data/meta-variant-report.csv';
  const fileArg = readOption('file');
  const apply = process.argv.includes('--apply');

  const [items, products] = await Promise.all([loadMetaItems(fileArg), loadProducts()]);
  const prisma = getPrisma();
  const mappedRetailers = new Map<string, VariantRow>();
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.metaRetailerId) {
        mappedRetailers.set(variant.metaRetailerId.trim().toUpperCase(), variant);
      }
    }
  }

  const estadoId = apply ? await inactiveEstadoId() : 0;
  const decisions: Decision[] = [];
  const usedRetailers = new Set<string>(mappedRetailers.keys());

  for (const item of items) {
    if (item.retailerId.startsWith('test_product_retailer_id_')) {
      decisions.push({ item, action: 'skipped', product: null, variant: null, detail: 'producto de prueba' });
      continue;
    }
    const retailerKey = item.retailerId.trim().toUpperCase();
    if (usedRetailers.has(retailerKey)) {
      decisions.push({
        item,
        action: 'already_mapped',
        product: null,
        variant: mappedRetailers.get(retailerKey) ?? null,
        detail: 'retailer_id ya mapeado',
      });
      continue;
    }

    const candidates = findProductCandidates(item, products);
    if (candidates.length === 0) {
      if (!apply) {
        decisions.push({ item, action: 'create_product', product: null, variant: null, detail: 'no existe producto base' });
        usedRetailers.add(retailerKey);
        continue;
      }
      const created = await createProductWithVariant(item, estadoId);
      if (!created) {
        decisions.push({ item, action: 'conflict', product: null, variant: null, detail: 'falló creación de producto' });
        continue;
      }
      products.push(created);
      const variant = created.variants[0]!;
      usedRetailers.add(retailerKey);
      decisions.push({ item, action: 'create_product', product: created, variant, detail: 'producto y variante creados inactivos' });
      continue;
    }

    const product = pickProduct(candidates, item);
    if (!product) {
      decisions.push({ item, action: 'ambiguous_product', product: null, variant: null, detail: 'varios productos base' });
      continue;
    }

    const choice = chooseVariant(product, item);
    if (choice.action === 'ambiguous_color') {
      decisions.push({ item, action: 'ambiguous_color', product, variant: choice.variant, detail: choice.detail });
      continue;
    }
    if (choice.action === 'no_color') {
      decisions.push({ item, action: 'no_color', product, variant: null, detail: choice.detail });
      continue;
    }

    if (choice.action === 'create_variant') {
      if (!apply) {
        decisions.push({ item, action: 'create_variant', product, variant: null, detail: choice.detail });
        usedRetailers.add(retailerKey);
        continue;
      }
      const created = await createVariant(product, item, estadoId);
      if (!created) {
        decisions.push({ item, action: 'conflict', product, variant: null, detail: 'falló creación de variante' });
        continue;
      }
      product.variants.push(created);
      usedRetailers.add(retailerKey);
      decisions.push({ item, action: 'create_variant', product, variant: created, detail: 'variante creada inactiva' });
      continue;
    }

    const variant = choice.variant!;
    if (variant.metaRetailerId && variant.metaRetailerId.trim().toUpperCase() !== retailerKey) {
      decisions.push({
        item,
        action: 'conflict',
        product,
        variant,
        detail: `la variante ya está mapeada a ${variant.metaRetailerId}`,
      });
      continue;
    }

    if (!apply) {
      decisions.push({ item, action: 'map', product, variant, detail: choice.detail });
      usedRetailers.add(retailerKey);
      continue;
    }

    try {
      await prisma.productoVariante.update({
        where: { idVariante: variant.idVariante },
        data: { metaRetailerId: item.retailerId, updatedAt: new Date() },
      });
      variant.metaRetailerId = item.retailerId;
      usedRetailers.add(retailerKey);
      decisions.push({ item, action: 'map', product, variant, detail: choice.detail });
    } catch (error) {
      decisions.push({
        item,
        action: 'conflict',
        product,
        variant,
        detail: `falló update: ${error instanceof Error ? error.message : 'error'}`,
      });
    }
  }

  const header = [
    'retailer_id',
    'meta_name',
    'meta_color',
    'action',
    'product_id',
    'product_name',
    'variant_id',
    'variant_sku',
    'variant_color',
    'detail',
    'price',
    'availability',
  ];
  const rows = decisions.map((decision) => [
    decision.item.retailerId,
    decision.item.name,
    decision.item.color.full,
    decision.action,
    decision.product?.idProducto ?? '',
    decision.product?.nombre ?? '',
    decision.variant?.idVariante ?? '',
    decision.variant?.sku ?? '',
    decision.variant?.color ?? '',
    decision.detail,
    decision.item.price ?? '',
    decision.item.availability ?? '',
  ]);
  const content = [header, ...rows]
    .map((row) => row.map((value) => csvEscape(String(value))).join(','))
    .join('\n');
  const absolutePath = resolve(process.cwd(), reportPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${content}\n`, 'utf8');

  const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
    acc[decision.action] = (acc[decision.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ apply, metaItems: items.length, products: products.length, counts }, null, 2));
  console.log(`Reporte: ${absolutePath}`);
  if (!apply) {
    console.log('Dry-run: no se escribió en la base. Revisa el CSV y ejecuta con --apply.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
