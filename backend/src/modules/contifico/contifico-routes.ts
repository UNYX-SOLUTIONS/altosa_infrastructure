import { Router } from 'express';
import * as contificoController from './contifico-controller';

export const contificoRouter = Router();

contificoRouter.get('/status', contificoController.status);
contificoRouter.get('/search', contificoController.search);
contificoRouter.get('/products', contificoController.listProducts);
contificoRouter.get('/products/:id', contificoController.getProduct);
contificoRouter.get('/categories', contificoController.listCategories);
contificoRouter.post('/import', contificoController.importProduct);
contificoRouter.post('/sync', contificoController.sync);
