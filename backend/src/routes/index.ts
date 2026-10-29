import { Router } from 'express';
import { catalogRouter } from '../modules/catalog/catalog-routes';
import { contificoRouter } from '../modules/contifico/contifico-routes';
import { externalRouter } from '../modules/external/external-routes';
import { kommoRouter } from '../modules/kommo/kommo-routes';
import { metaRouter } from '../modules/meta/meta-routes';
import { uploadsRouter } from '../modules/uploads/uploads-routes';

export const apiRouter = Router();

apiRouter.use('/', catalogRouter);
apiRouter.use('/contifico', contificoRouter);
apiRouter.use('/external', externalRouter);
apiRouter.use('/kommo', kommoRouter);
apiRouter.use('/meta', metaRouter);
apiRouter.use('/uploads', uploadsRouter);
