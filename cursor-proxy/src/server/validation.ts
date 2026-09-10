// Server request validator
import { Request, Response, NextFunction } from 'express';

export function validateRequestBody(req: Request, res: Response, next: NextFunction): void {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && (!req.body || Object.keys(req.body).length === 0)) {
    res.status(400).json({ error: { message: 'Request body is required' } });
    return;
  }
  next();
}

export function validateChatRequest(req: Request, res: Response, next: NextFunction): void {
  const { model, messages } = req.body;
  if (!model || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: 'model and messages (array) are required' } });
    return;
  }
  next();
}
