// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

import { Router } from 'express';
import { handleModelsList } from '../handlers/modelsHandler.js';

export const router = Router();
router.get('/', handleModelsList);
