import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, buildMeta, sendSuccess } from '../../utils/api-response';
import {
  categoriesQuerySchema,
  categoryCreateBodySchema,
  categoryUpdateBodySchema,
  createProductBodySchema,
  documentsQuerySchema,
  idParamSchema,
  productsQuerySchema,
  simpleListQuerySchema,
  skuParamSchema,
  subcategoryCreateBodySchema,
  subcategoryUpdateBodySchema,
  syncDeactivateBodySchema,
  syncProductsBodySchema,
  updateProductBodySchema,
  updateVariantBodySchema,
  variantBodySchema,
  warrantyCreateBodySchema,
  warrantyIdParamSchema,
  warrantyListQuerySchema,
  warrantyUpdateBodySchema,
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

export async function listCategories(req: Request, res: Response): Promise<void> {
  const { scope } = categoriesQuerySchema.parse(req.query);
  const categorias =
    scope === 'admin'
      ? await catalogService.listCategoriesAdmin()
      : await catalogService.listCategories();
  sendSuccess(res, categorias);
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const input = categoryCreateBodySchema.parse(req.body);
  const categoria = await catalogService.createCategory(input);
  sendSuccess(res, categoria, undefined, StatusCodes.CREATED);
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = categoryUpdateBodySchema.parse(req.body);
  const categoria = await catalogService.updateCategory(id, input);
  sendSuccess(res, categoria);
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await catalogService.deleteCategory(id);
  sendSuccess(res, result);
}

export async function createSubcategory(req: Request, res: Response): Promise<void> {
  const input = subcategoryCreateBodySchema.parse(req.body);
  const subcategoria = await catalogService.createSubcategory(input);
  sendSuccess(res, subcategoria, undefined, StatusCodes.CREATED);
}

export async function updateSubcategory(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = subcategoryUpdateBodySchema.parse(req.body);
  const subcategoria = await catalogService.updateSubcategory(id, input);
  sendSuccess(res, subcategoria);
}

export async function deleteSubcategory(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await catalogService.deleteSubcategory(id);
  sendSuccess(res, result);
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
  const query = warrantyListQuerySchema.parse(req.query);
  const garantias = await catalogService.listWarranties(query);
  sendSuccess(res, garantias);
}

export async function createWarranty(req: Request, res: Response): Promise<void> {
  const input = warrantyCreateBodySchema.parse(req.body);
  const garantia = await catalogService.createWarranty(input);
  sendSuccess(res, garantia, undefined, StatusCodes.CREATED);
}

export async function updateWarranty(req: Request, res: Response): Promise<void> {
  const { id } = warrantyIdParamSchema.parse(req.params);
  const input = warrantyUpdateBodySchema.parse(req.body);
  const garantia = await catalogService.updateWarranty(id, input);
  sendSuccess(res, garantia);
}

export async function deleteWarranty(req: Request, res: Response): Promise<void> {
  const { id } = warrantyIdParamSchema.parse(req.params);
  const result = await catalogService.deleteWarranty(id);
  sendSuccess(res, result);
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
  if (req.query.permanent === 'true') {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'El borrado definitivo está deshabilitado. Solo se permite anular; los ítems se conservan en Meta/Contifico desactivados.',
      'ALTOSA_PERMANENT_DELETE_DISABLED'
    );
  }
  const producto = await catalogService.annulProduct(id);
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
  if (req.query.permanent === 'true') {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'El borrado definitivo está deshabilitado. Solo se permite anular; los ítems se conservan en Meta/Contifico desactivados.',
      'ALTOSA_PERMANENT_DELETE_DISABLED'
    );
  }
  const variante = await catalogService.annulVariant(id);
  sendSuccess(res, variante);
}

export async function syncProducts(req: Request, res: Response): Promise<void> {
  const {
    items,
    matchByName,
    syncExternals,
    writeThroughMeta,
    writeThroughContifico,
  } = syncProductsBodySchema.parse(req.body);
  const result = await catalogService.syncProducts(items, {
    matchByName,
    syncExternals,
    writeThroughMeta,
    writeThroughContifico,
  });
  sendSuccess(res, result);
}

export async function deactivateProducts(req: Request, res: Response): Promise<void> {
  const { skus } = syncDeactivateBodySchema.parse(req.body);
  const result = await catalogService.deactivateProductsBySku(skus);
  sendSuccess(res, result);
}
