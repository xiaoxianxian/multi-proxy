import { Request, Response } from 'express';
import { ProviderRegistry } from '../../providers/registry.js';
import { db } from '../../db/database.js';

export async function handleModelsList(_req: Request, res: Response): Promise<void> {
  // 从数据库中获取所有启用的模型
  const models = db.prepare(`
    SELECT m.name, p.name as provider_name, p.provider_id
    FROM models m
    LEFT JOIN providers p ON m.provider_id = p.id
    WHERE m.enabled = 1
    ORDER BY p.name, m.name
  `).all();

  const result = (models as any[]).map((m: any) => ({
    id: m.name,
    object: 'model' as const,
    created: Math.floor(Date.now() / 1000),
    owned_by: m.provider_name || m.provider_id || 'unknown',
  }));

  res.json({ object: 'list', data: result });
}
