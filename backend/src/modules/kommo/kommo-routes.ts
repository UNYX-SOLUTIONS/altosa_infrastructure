import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import * as kommoController from './kommo-controller';

export const kommoRouter = Router();

kommoRouter.get('/templates', asyncHandler(kommoController.listTemplates));
kommoRouter.post('/sync-templates', asyncHandler(kommoController.syncTemplates));
