import { Router } from 'express';
import { handleChatCompletion } from '../handlers/chatHandler.js';

export const router = Router();
router.post('/chat/completions', handleChatCompletion);
