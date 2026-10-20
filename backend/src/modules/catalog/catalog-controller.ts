import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { buildMeta, sendSuccess } from '../../utils/api-response';
import {
  createProductBodySchema,
  documentsQuerySchema,
  idParamSchema,
  productsQuerySchema,
  simpleListQuerySchema,
  skuParamSchema,
  syncDeactivateBodySchema,
  syncProductsBodySchema,
  updateProductBodySchema,
  updateVariantBodySchema,
  variantBodySchema,
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

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export async function createProduct(req: Request, res: Response): Promise<void> {
  const input = createProductBodySchema.parse(req.body);
  const producto = await catalogService.createProduct(input);
  sendSuccess(res, producto, undefined, StatusCodes.CREATED);
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = updateProductBodySchema.parse(req.body);
  const producto = await catalogService.updateProduct(id, input);
  sendSuccess(res, producto);
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const producto = await catalogService.deactivateProduct(id);
  sendSuccess(res, producto);
}

export async function createVariant(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = variantBodySchema.parse(req.body);
  const variante = await catalogService.createVariant(id, input);
  sendSuccess(res, variante, undefined, StatusCodes.CREATED);
}

export async function updateVariant(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = updateVariantBodySchema.parse(req.body);
  const variante = await catalogService.updateVariant(id, input);
  sendSuccess(res, variante);
}

export async function deleteVariant(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const variante = await catalogService.deactivateVariant(id);
  sendSuccess(res, variante);
}

export async function syncProducts(req: Request, res: Response): Promise<void> {
  const { items, matchByName } = syncProductsBodySchema.parse(req.body);
  const result = await catalogService.syncProducts(items, { matchByName });
  sendSuccess(res, result);
}

export async function deactivateProducts(req: Request, res: Response): Promise<void> {
  const { skus } = syncDeactivateBodySchema.parse(req.body);
  const result = await catalogService.deactivateProductsBySku(skus);
  sendSuccess(res, result);
}
