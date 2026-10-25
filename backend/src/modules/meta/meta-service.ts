import { HttpError } from '../../utils/api-response';
import {
  findMetaCatalogItem,
  searchMetaCatalog,
  type MetaCatalogItem,
} from './meta-client';

export async function searchCatalog(
  query: string,
  limit: number
): Promise<{ items: MetaCatalogItem[] }> {
  const items = await searchMetaCatalog(query, limit);
  return { items };
}

export async function getCatalogItem(retailerId: string): Promise<MetaCatalogItem> {
  const item = await findMetaCatalogItem(retailerId);
  if (!item) {
    throw new HttpError(
      404,
      `El Retailer ID "${retailerId}" no existe en el catálogo de Meta.`,
      'META_ITEM_NOT_FOUND'
    );
  }
  return item;
}
