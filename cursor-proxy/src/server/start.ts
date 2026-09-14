import app from './app.js';
import { HealthMonitor } from '../monitoring/healthMonitor.js';
import { loadEnabledProviderConfigs, setOverrideLogSink } from './handlers/chatHandler.js';
import { setHealthContext } from '../routing/routing-shadow.js';
import { db } from '../db/database.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

// D6-b · override 决策审计持久化（门控 PROXY_ROUTE_OVERRIDE，与 override 主路径同开关）
// 仅在 override 灰度开启时接上落盘：recordOverrideEntry 把每条 override 决策追加进
// data/override-audit.jsonl，供灰度期跨重启复盘（getOverrideLog 只读内存、重启即失，
// readOverrideAudit 读盘才是长期观测入口）。门控关 → 不接 sink → 零写盘、零热路径开销。
// 路径可用 PROXY_OVERRIDE_AUDIT_LOG 覆盖（测试 / 自定义落点）。
const overrideGate = String(process.env.PROXY_ROUTE_OVERRIDE ?? '').trim().toLowerCase();
if (overrideGate === '1' || overrideGate === 'true' || overrideGate === 'on') {
  const auditPath = process.env.PROXY_OVERRIDE_AUDIT_LOG
    || path.join(__dirname, '..', '..', 'data', 'override-audit.jsonl');
  try {
    setOverrideLogSink(auditPath);
    console.log(`[override-audit] 已接持久化落盘 ${auditPath}（PROXY_ROUTE_OVERRIDE=1）`);
  } catch (e) {
    // 接 sink 失败不影响主链路
    console.warn('[override-audit] 接线失败（不影响主链路）:', e instanceof Error ? e.message : e);
  }
 } else {
  console.log('[override-audit] 未启用（PROXY_ROUTE_OVERRIDE 未设置或≠1/true/on，不写盘）');
}

app.listen(PORT, () => {
  console.log(`[Proxy Server] 代理服务运行于 http://0.0.0.0:${PORT}`);
  console.log(`[Proxy Server] 管理面板 http://0.0.0.0:${PORT}/admin-api`);
});
