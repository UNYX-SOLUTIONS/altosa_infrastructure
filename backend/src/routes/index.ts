import { Router } from 'express';
import { catalogRouter } from '../modules/catalog/catalog-routes';

export const apiRouter = Router();

apiRouter.use('/', catalogRouter);
