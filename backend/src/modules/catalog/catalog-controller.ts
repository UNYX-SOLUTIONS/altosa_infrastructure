import type { Request, Response } from 'express';
import { buildMeta, sendSuccess } from '../../utils/api-response';
import {
  documentsQuerySchema,
  idParamSchema,
  productsQuerySchema,
  simpleListQuerySchema,
  skuParamSchema,
} from './catalog-schema';
import * as catalogService from './catalog-service';

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = productsQuerySchema.parse(req.query);
  const { items, total } = await catalogService.listProducts(query);
  sendSuccess(res, items, buildMeta(query.page, query.pageSize, total));
}

export async function getProductById(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const producto = await catalogService.getProductById(id);
  sendSuccess(res, producto);
}

export async function getProductBySku(req: Request, res: Response): Promise<void> {
  const { sku } = skuParamSchema.parse(req.params);
  const result = await catalogService.getProductByVariantSku(sku);
  sendSuccess(res, result);
}

export async function listCategories(_req: Request, res: Response): Promise<void> {
  const categorias = await catalogService.listCategories();
  sendSuccess(res, categorias);
}

export async function listCatalogs(req: Request, res: Response): Promise<void> {
  const query = simpleListQuerySchema.parse(req.query);
  const catalogos = await catalogService.listCatalogs(query);
  sendSuccess(res, catalogos);
}

export async function listLocations(req: Request, res: Response): Promise<void> {
  const query = simpleListQuerySchema.parse(req.query);
  const ubicaciones = await catalogService.listLocations(query);
  sendSuccess(res, ubicaciones);
}

export async function listWarranties(req: Request, res: Response): Promise<void> {
  const query = simpleListQuerySchema.parse(req.query);
  const garantias = await catalogService.listWarranties(query);
  sendSuccess(res, garantias);
}

export async function listDocuments(req: Request, res: Response): Promise<void> {
  const query = documentsQuerySchema.parse(req.query);
  const { items, total } = await catalogService.listDocuments(query);
  sendSuccess(res, items, buildMeta(query.page, query.pageSize, total));
}
