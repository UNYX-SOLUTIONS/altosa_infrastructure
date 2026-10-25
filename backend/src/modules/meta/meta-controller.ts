import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/api-response';
import { metaCatalogItemQuerySchema, metaCatalogSearchQuerySchema } from './meta-schema';
import * as metaService from './meta-service';

export async function searchCatalog(req: Request, res: Response): Promise<void> {
  const query = metaCatalogSearchQuerySchema.parse(req.query);
  const result = await metaService.searchCatalog(query.q, query.limit);
  sendSuccess(res, result);
}

export async function getCatalogItem(req: Request, res: Response): Promise<void> {
  const query = metaCatalogItemQuerySchema.parse(req.query);
  const item = await metaService.getCatalogItem(query.retailerId);
  sendSuccess(res, item);
}
