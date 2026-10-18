// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E Test Group 5: 认证绕过保护 — P1/P2 regen (10-16).
 *
 * P1 根因(查实 07:xx 10-16):
 *  - BASE_URL 旧写死生产 18792 → 改 helper(默认 18801 隔离)。
 *  - test「accept valid token」走「setup→等#loginMode→手动 login」旧流 → 改 helpers.login()。
 *  - 认证头实为 `x-auth-token`(lib/auth.js:124, 兼容 cookie auth_token); 旧「clear localStorage」
 *    清错存储(token 在 sessionStorage), 改清 sessionStorage(Playwright 每 test 新 context, 本就空, 双保险)。
 * P0 安全(10-16): 仅 throwaway HOME 清密码(401 测试需 fresh 无密码态走 setup); 不碰真凭据。
 */

import { test, expect } from '@playwright/test';
import { login, BASE_URL } from './helpers';

// 每个 test 新 context 起始即「未登录」; 这里显式清 sessionStorage 双保险。
async function wipeAuth(page) {
  await page.goto(`${BASE_URL}/login.html`);
  await page.evaluate(() => sessionStorage.clear());
}

test.describe('E2E Group 5: Auth Bypass Protection', () => {

  test('should gate unauthenticated access to logs page', async ({ page }) => {
    await wipeAuth(page);
    await page.goto(`${BASE_URL}/logs.html`);
      // P1: 未登录访问 logs → redirect 到 login.html(快照实证: 落到 login.html「欢迎回来」)。
    await page.waitForURL(/.*login\.html/);
    });

  test('should gate unauthenticated access to proxy-config', async ({ page }) => {
    await wipeAuth(page);
    await page.goto(`${BASE_URL}/proxy-config.html?proxy=codex`, { waitUntil: 'load' });
    // P3(10-19): 门禁重定向到登录页为铁证(URL); 配置内容不外泄; 模式脚本按密码状态异步切换——
    // 旧 first() 取 DOM 序靠前的 #setupMode, 登录模式下恒 hidden 造成误判。等恰有一个 mode 可见。
    await expect(page).toHaveURL(/login\.html/);
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(page.locator('#setupMode:visible, #loginMode:visible')).toHaveCount(1, { timeout: 10000 });
    });

  test('should return 401 for protected logs API without token', async ({ page }) => {
    await wipeAuth(page);
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      return res.status;
    });
    expect(status).toBe(401);
    });

  test('should return 401 for stop API without token', async ({ page }) => {
    await wipeAuth(page);
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/stop/codex', { method: 'POST' });
      return res.status;
    });
    expect(status).toBe(401);
    });

  test('should return 401 for start API without token', async ({ page }) => {
    await wipeAuth(page);
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/start/codex', { method: 'POST' });
      return res.status;
    });
    expect(status).toBe(401);
    });

  test('should accept a valid token for a protected API', async ({ page }) => {
      // P1: 设置密码即 auto-redirect dashboard(token 入 sessionStorage); 用 x-auth-token 调受控端点。
    const token = await login(page);
    expect(token).toBeTruthy();
    const status = await page.evaluate(async (tok) => {
      const res = await fetch('/api/status', { headers: { 'x-auth-token': tok } });
      return res.status;
    }, token);
    expect(status).toBe(200);
    });

  test('should expose a public auth status endpoint', async ({ request }) => {
      // 10-19 预案: goto+evaluate 与 SPA 二次导航竞态(execution context destroyed),
    // 换 APIRequestContext(纯 HTTP, 无浏览器上下文); 断言不变: 200 + needsSetup 字段存在。
    const r = await request.get('/api/auth/status');
    expect(r.status()).toBe(200);
    expect(await r.json()).toHaveProperty('needsSetup');
    });
});
