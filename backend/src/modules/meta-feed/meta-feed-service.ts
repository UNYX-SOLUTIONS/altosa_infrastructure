import { getPrisma } from '../../config/prisma';
import { buildFlatName } from '../../utils/product-naming';

export type MetaFeedScope = 'published' | 'meta' | 'active' | 'all';

const META_FEED_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
  'google_product_category',
  'fb_product_category',
  'quantity_to_sell_on_facebook',
  'sale_price',
  'sale_price_effective_date',
  'item_group_id',
  'gender',
  'color',
  'size',
  'age_group',
  'material',
  'pattern',
  'shipping',
  'shipping_weight',
  'offer_disclaimer',
  'offer_disclaimer_url',
  'video[0].url',
  'video[0].tag[0]',
  'gtin',
  'product_tags[0]',
  'product_tags[1]',
  'style[0]',
] as const;

type FeedColumn = (typeof META_FEED_COLUMNS)[number];
type FeedRow = Record<FeedColumn, string>;

export interface MetaFeedResult {
  csv: string;
  rows: number;
  skipped: number;
  skippedSamples: string[];
  scope: MetaFeedScope;
  generatedAt: string;
}

function parseSpecs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stockOf(raw: string | null): number {
  const value = Number(parseSpecs(raw).stock);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function cleanText(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trim() : value;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function formatPrice(value: unknown): string | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return `${number.toFixed(2)} USD`;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function buildMetaFeed(scope: MetaFeedScope): Promise<MetaFeedResult> {
  const prisma = getPrisma();
  const where =
    scope === 'all'
      ? {}
      : scope === 'meta'
        ? { metaRetailerId: { not: null } }
        : scope === 'active'
          ? { isActive: true }
          : { OR: [{ metaRetailerId: { not: null } }, { isActive: true }] };

  const variants = await prisma.productoVariante.findMany({
    where,
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      nombre: true,
      color: true,
      descripcion: true,
      precioUsd: true,
      imagenUrl: true,
      urlProducto: true,
      material: true,
      especificacionesAdicionales: true,
      isActive: true,
      metaRetailerId: true,
      producto: {
        select: {
          producto: true,
          descripcion: true,
          usoRecomendado: true,
          isActive: true,
          subcategoria: {
            select: {
              nombre: true,
              categoria: { select: { nombre: true } },
            },
          },
          _count: { select: { variants: true } },
          variants: {
            where: { imagenUrl: { not: null } },
            select: { imagenUrl: true },
            take: 1,
          },
        },
      },
    },
    orderBy: { idVariante: 'asc' },
  });

  const usedIds = new Set<string>();
  const rows: FeedRow[] = [];
  const skippedSamples: string[] = [];
  let skipped = 0;

  for (const variant of variants) {
    const product = variant.producto;
    const stock = stockOf(variant.especificacionesAdicionales);
    const title = truncate(
      cleanText(
        variant.nombre || buildFlatName(product.producto, variant.color ?? null)
      ),
      200
    );
    const description = truncate(
      cleanText(
        variant.descripcion ||
          product.descripcion ||
          product.usoRecomendado ||
          title
      ),
      9999
    );
    const price = formatPrice(variant.precioUsd);
    const link =
      validHttpUrl(variant.urlProducto) ??
      (slugify(product.producto)
        ? `https://altosamobiliario.com/producto/${slugify(product.producto)}/`
        : null);
    const image =
      validHttpUrl(variant.imagenUrl) ??
      validHttpUrl(product.variants[0]?.imagenUrl);

    if (!title || !description || !price || !link || !image) {
      skipped += 1;
      if (skippedSamples.length < 30) {
        skippedSamples.push(
          `${variant.idVariante}:${variant.metaRetailerId ?? variant.sku ?? 'sin-id'}`
        );
      }
      continue;
    }

    const baseId = truncate(
      String(variant.metaRetailerId ?? variant.sku ?? `ALT-${variant.idVariante}`),
      100
    );
    let id = baseId;
    if (usedIds.has(id)) {
      id = truncate(`${baseId}-${variant.idVariante}`, 100);
    }
    usedIds.add(id);

    const isAvailable =
      variant.isActive && product.isActive && stock > 0 ? 'in stock' : 'out of stock';
    const color =
      variant.color && !/^est[aá]ndar$/i.test(variant.color.trim())
        ? truncate(cleanText(variant.color), 200)
        : '';
    const category = cleanText(product.subcategoria?.categoria?.nombre ?? '');
    const subcategory = cleanText(product.subcategoria?.nombre ?? '');

    rows.push({
      id,
      title,
      description,
      availability: isAvailable,
      condition: 'new',
      price,
      link,
      image_link: image,
      brand: 'Altosamobiliario',
      google_product_category: '',
      fb_product_category: '',
      quantity_to_sell_on_facebook: stock > 0 ? String(Math.floor(stock)) : '',
      sale_price: '',
      sale_price_effective_date: '',
      item_group_id:
        product._count.variants > 1 ? `ALT-P-${variant.idProducto}` : '',
      gender: '',
      color,
      size: '',
      age_group: '',
      material: truncate(cleanText(variant.material ?? ''), 200),
      pattern: '',
      shipping: '',
      shipping_weight: '',
      offer_disclaimer: '',
      offer_disclaimer_url: '',
      'video[0].url': '',
      'video[0].tag[0]': '',
      gtin: '',
      'product_tags[0]': truncate(category, 110),
      'product_tags[1]': truncate(subcategory, 110),
      'style[0]': '',
    });
  }

  const csvLines = [
    META_FEED_COLUMNS.join(','),
    ...rows.map((row) =>
      META_FEED_COLUMNS.map((column) => csvEscape(row[column])).join(',')
    ),
  ];

  return {
    csv: `${csvLines.join('\r\n')}\r\n`,
    rows: rows.length,
    skipped,
    skippedSamples,
    scope,
    generatedAt: new Date().toISOString(),
  };
}
