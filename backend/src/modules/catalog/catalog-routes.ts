import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import * as catalogController from './catalog-controller';

export const catalogRouter = Router();

catalogRouter.get('/products', asyncHandler(catalogController.listProducts));
catalogRouter.get('/products/sku/:sku', asyncHandler(catalogController.getProductBySku));
catalogRouter.get('/products/:id', asyncHandler(catalogController.getProductById));

catalogRouter.get('/categories', asyncHandler(catalogController.listCategories));
catalogRouter.get('/catalogs', asyncHandler(catalogController.listCatalogs));
catalogRouter.get('/locations', asyncHandler(catalogController.listLocations));
catalogRouter.get('/warranties', asyncHandler(catalogController.listWarranties));
catalogRouter.get('/documents', asyncHandler(catalogController.listDocuments));
