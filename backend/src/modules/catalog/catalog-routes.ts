import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import * as catalogController from './catalog-controller';

export const catalogRouter = Router();

catalogRouter.post('/sync/products', asyncHandler(catalogController.syncProducts));
catalogRouter.post('/sync/products/deactivate', asyncHandler(catalogController.deactivateProducts));

catalogRouter.get('/products', asyncHandler(catalogController.listProducts));
catalogRouter.get('/products/sku/:sku', asyncHandler(catalogController.getProductBySku));
catalogRouter.get('/products/:id', asyncHandler(catalogController.getProductById));
catalogRouter.post('/products', asyncHandler(catalogController.createProduct));
catalogRouter.patch('/products/:id', asyncHandler(catalogController.updateProduct));
catalogRouter.delete('/products/:id', asyncHandler(catalogController.deleteProduct));
catalogRouter.post('/products/:id/variants', asyncHandler(catalogController.createVariant));
catalogRouter.patch('/variants/:id', asyncHandler(catalogController.updateVariant));
catalogRouter.delete('/variants/:id', asyncHandler(catalogController.deleteVariant));

catalogRouter.get('/categories', asyncHandler(catalogController.listCategories));
catalogRouter.post('/categories', asyncHandler(catalogController.createCategory));
catalogRouter.patch('/categories/:id', asyncHandler(catalogController.updateCategory));
catalogRouter.delete('/categories/:id', asyncHandler(catalogController.deleteCategory));
catalogRouter.post('/subcategories', asyncHandler(catalogController.createSubcategory));
catalogRouter.patch('/subcategories/:id', asyncHandler(catalogController.updateSubcategory));
catalogRouter.delete('/subcategories/:id', asyncHandler(catalogController.deleteSubcategory));
catalogRouter.get('/catalogs', asyncHandler(catalogController.listCatalogs));
catalogRouter.get('/locations', asyncHandler(catalogController.listLocations));
catalogRouter.get('/warranties', asyncHandler(catalogController.listWarranties));
catalogRouter.post('/warranties', asyncHandler(catalogController.createWarranty));
catalogRouter.patch('/warranties/:id', asyncHandler(catalogController.updateWarranty));
catalogRouter.delete('/warranties/:id', asyncHandler(catalogController.deleteWarranty));
catalogRouter.get('/documents', asyncHandler(catalogController.listDocuments));
