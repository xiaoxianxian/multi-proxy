import app from './app.js';
import { HealthMonitor } from '../monitoring/healthMonitor.js';
import { loadEnabledProviderConfigs } from './handlers/chatHandler.js';
import { setHealthContext } from '../routing/routing-shadow.js';
import { db } from '../db/database.js';

const PORT = parseInt(process.env.PORT || '18794');

// D6-a · 健康信号接线（PROXY_HEALTH_MONITOR 门控，默认关闭）
// shadow 观测阶段启用；不改变路由结果，只提供健康状态供候选集构建参考。
const healthGate = String(process.env.PROXY_HEALTH_MONITOR ?? '').trim().toLowerCase();
if (healthGate === '1' || healthGate === 'true' || healthGate === 'on') {
  try {
    const monitor = new HealthMonitor();
    const configsRef = { current: loadEnabledProviderConfigs() };
    const modelRows = db.prepare('SELECT name, provider_id FROM models WHERE enabled = 1').all() as any[];
    const modelToProvider = new Map(modelRows.map((r: any) => [r.name, r.provider_id]));
    setHealthContext(monitor, modelToProvider);
    monitor.start(configsRef);
    console.log(`[HealthMonitor] 已启动（PROXY_HEALTH_MONITOR=1），${configsRef.current.length} 个 enabled provider 在轮询，30s 间隔`);
    process.on('SIGTERM', () => monitor.stop());
    process.on('SIGINT', () => monitor.stop());
   } catch (e) {
    console.warn('[HealthMonitor] 启动失败（不影响主链路）:', e instanceof Error ? e.message : e);
   }
 } else {
  console.log('[HealthMonitor] 未启用（PROXY_HEALTH_MONITOR 未设置或≠1/true/on）');
 }

app.listen(PORT, () => {
  console.log(`[Proxy Server] 代理服务运行于 http://0.0.0.0:${PORT}`);
  console.log(`[Proxy Server] 管理面板 http://0.0.0.0:${PORT}/admin-api`);
});
