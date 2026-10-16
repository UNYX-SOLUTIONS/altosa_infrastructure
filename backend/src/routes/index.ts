import { Router } from 'express';
import { catalogRouter } from '../modules/catalog/catalog-routes';
import { uploadsRouter } from '../modules/uploads/uploads-routes';

export const apiRouter = Router();

apiRouter.use('/', catalogRouter);
apiRouter.use('/uploads', uploadsRouter);
