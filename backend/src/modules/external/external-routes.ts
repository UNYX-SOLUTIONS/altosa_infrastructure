import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import * as externalController from './external-controller';

export const externalRouter = Router();

externalRouter.get('/meta/pending', asyncHandler(externalController.listMetaPending));
externalRouter.get('/links', asyncHandler(externalController.listLinks));
externalRouter.post('/import', asyncHandler(externalController.importItems));
