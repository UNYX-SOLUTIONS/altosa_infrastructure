import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { metaRateLimiter } from '../../middlewares/rate-limit-middleware';
import * as metaController from './meta-controller';

export const metaRouter = Router();

metaRouter.use(metaRateLimiter);
metaRouter.get('/catalog/search', asyncHandler(metaController.searchCatalog));
metaRouter.get('/catalog/item', asyncHandler(metaController.getCatalogItem));
