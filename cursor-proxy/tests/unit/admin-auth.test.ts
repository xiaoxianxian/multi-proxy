/**
 * Admin API 认证测试（P0-4）
 * 验证：设置 PROXY_AUTH_TOKEN 后 /admin-api/* 需要 x-proxy-auth 头；
 * 未设置时不启用认证（向后兼容）；/health 不受影响。
 * 通过真实 HTTP 监听测试：fork dist/server/start.js 于随机高位端口。
 */
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_JS = path.join(__dirname, '../../dist/server/start.js');

function startServer(extraEnv = {}): Promise<{ child: any; base: string }> {
  return new Promise((resolve, reject) => {
    const port = 18990 + Math.floor(Math.random() * 100);
    const child = fork(START_JS, [], {
      env: { ...process.env, PORT: String(port), ...extraEnv },
      silent: true,
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    // 轮询 /health 直到服务就绪
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(base + '/health');
        if (res.ok) {
          clearInterval(timer);
          resolve({ child, base });
          return;
        }
      } catch (e) { /* not up yet */ }
      if (attempts > 50) {
        clearInterval(timer);
        child.kill();
        reject(new Error('server start timeout'));
      }
    }, 150);
  });
}

afterEach(() => { /* children killed in each test's finally */ });

async function req(method: string, base: string, p: string, headers: Record<string,string> = {}, body?: any) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

describe('Admin API 认证 (P0-4)', () => {
  test('设置 PROXY_AUTH_TOKEN：无 token 访问 admin-api → 401', async () => {
    const { child, base } = await startServer({ PROXY_AUTH_TOKEN: 'secret-token-1' });
    try {
      const r = await req('GET', base, '/admin-api/providers');
      expect(r.status).toBe(401);
    } finally { child.kill(); }
  }, 20000);

  test('设置 PROXY_AUTH_TOKEN：正确 token → 200', async () => {
    const { child, base } = await startServer({ PROXY_AUTH_TOKEN: 'secret-token-1' });
    try {
      const r = await req('GET', base, '/admin-api/health', { 'x-proxy-auth': 'secret-token-1' });
      expect(r.status).toBe(200);
    } finally { child.kill(); }
  }, 20000);

  test('未设置 token：admin-api 保持开放（向后兼容）', async () => {
    const { child, base } = await startServer({});
    try {
      const r = await req('GET', base, '/admin-api/health');
      expect(r.status).toBe(200);
    } finally { child.kill(); }
  }, 20000);

  test('/health 不受认证影响', async () => {
    const { child, base } = await startServer({ PROXY_AUTH_TOKEN: 'secret-token-1' });
    try {
      const r = await req('GET', base, '/health');
      expect(r.status).toBe(200);
      expect(r.json.status).toBe('ok');
    } finally { child.kill(); }
  }, 20000);

  test('CORS 默认不放行任意 Origin', async () => {
    const { child, base } = await startServer({});
    try {
      const res = await fetch(base + '/health', { headers: { Origin: 'http://evil.example.com' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally { child.kill(); }
  }, 20000);
});
