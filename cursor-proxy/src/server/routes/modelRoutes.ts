import { Router } from 'express';
import { handleModelsList } from '../handlers/modelsHandler.js';

export const router = Router();
router.get('/', handleModelsList);
