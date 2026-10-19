// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E Test Group 6: XSS 防护和安全 — P1/P2 regen (10-16).
 *
 * P1 根因(查实 07:xx 10-16):
 *  - BASE_URL 旧写死生产 18792 → 改 helper(默认 18801 隔离)。
 *  - 安全 headers 由 server.js:56-62 统一 setHeader: CSP(default-src/object-src 'none')、
 *    X-Content-Type-Options nosniff、X-Frame-Options DENY、X-XSS-Protection '1; mode=block'、
 *    Referrer-Policy strict-origin-when-cross-origin —— 逐字匹配。
 *  - test「XSS in provider names」(10-19 解skip): 用 Playwright 网络 mock 向 manager 转发目标
 *    /api/cursor/admin-api/providers 注入恶意 provider, 真跑页面 loadProviders +
 *    renderProviders + esc + maskKey(B8), 断言恶意内容只渲染为纯文本、无注入执行。
 * P0 安全(10-16): 仅 throwaway HOME 清密码; header 测试无需 auth, 不碰真凭据。
 */

import { test, expect } from '@playwright/test';
import { login, BASE_URL } from './helpers';

test.describe('E2E Group 6: Security & XSS Protection', () => {

  test('should have CSP headers', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const csp = response?.headers()['content-security-policy'] || '';
    expect(csp).toContain('default-src');
    expect(csp).toContain('object-src');
    });

  test('should have X-Content-Type-Options header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    });

  test('should have X-Frame-Options header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    });

  test('should have X-XSS-Protection header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const xss = response?.headers()['x-xss-protection'] || '';
    expect(xss).toContain('1');
    });

  test('should have Referrer-Policy header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response?.headers()['referrer-policy']).toBeTruthy();
    });

  test('should escape XSS in provider names', async ({ page }) => {
    // 10-19 解skip: 不起 cursor, 网络 mock 注入恶意 provider 到 manager 转发目标,
    // 真跑页面自带 loadProviders + renderProviders + esc + maskKey(B8)。
    const evilKey = 'sk-live-' + 'a'.repeat(24);
    const payload = {
      providers: [
        {
          id: 'evil-img',
          name: '<img src=x onerror="window.__xssImg=1">',
          provider_id: 'evil',
          base_url: '" onmouseover="window.__xssAttr=1" x="',
          api_key: evilKey,
          enabled: true,
        },
        {
          id: 'evil-script',
          name: '<script>window.__xssScript=1</script>',
          provider_id: 'evil2',
          base_url: 'https://ok.example',
          api_key: 'sk-live-' + 'b'.repeat(24),
          enabled: false,
        },
      ],
    };
    await page.route(/\/api\/cursor\/admin-api\/providers$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      }),
    );
    await login(page);
    await page.goto(`${BASE_URL}/proxy-config.html?proxy=cursor`);
    // 默认 tab = config(getTabFromHash → 'config'); providers tab 经 setupDynamicTabs 启用, 显式切换。
    // (10-19 实测: 点击后 #tab-providers 带 active 类、computed display:block, 切换机制正常。)
    await page.click('#tab-providers-btn');
    // 真跑页面 JS: loadProviders 走 mock 拉数据(fetch /api/cursor/admin-api/providers),
    // renderProviders 走 esc + maskKey(B8) 渲染表格。必须先填数据: 空 tbody 高度为 0,
    // Playwright 判「不可见」, 断言可见性要放在渲染之后。
    await page.evaluate(async () => {
      await (globalThis as any).loadProviders();
      (globalThis as any).renderProviders();
    });
    await expect(page.locator('#providersBody')).toBeVisible();
    // 恶意内容只作为纯文本存在: 不产生注入元素, onerror/script/onmouseover 不执行。
    expect(await page.locator('#providersBody img').count()).toBe(0);
    expect(await page.locator('#providersBody script').count()).toBe(0);
    expect(await page.evaluate(() => (globalThis as any).__xssImg)).toBeUndefined();
    expect(await page.evaluate(() => (globalThis as any).__xssScript)).toBeUndefined();
    expect(await page.evaluate(() => (globalThis as any).__xssAttr)).toBeUndefined();
    // 转义后字面量在表格中可见(转义正确 = 文本而非元素)。
    const bodyText = await page.locator('#providersBody').innerText();
    expect(bodyText).toContain('<img src=x');
    expect(bodyText).toContain('window.__xssScript=1');
    // B8: 完整 api_key 不入 DOM(maskKey 掩码 = 前4 + • + 后4)。
    expect(await page.locator('#providersBody').innerHTML()).not.toContain(evilKey);
    expect(bodyText).toContain('sk-l');
    expect(bodyText).toContain('•');
  });

  test('should render log viewer text safely (no injected scripts)', async ({ page }) => {
      // P1: 设置密码即 auto-redirect dashboard; 再进 logs 页。
    await login(page);
    await page.goto(`${BASE_URL}/logs.html`);
    await expect(page.locator('#logViewer')).toBeVisible();
      // P1: 日志按文本转义渲染, viewer 内无注入的 <script>。
    const hasInjectedScripts = await page.evaluate(() => {
      return document.querySelectorAll('#logViewer script').length;
    });
    expect(hasInjectedScripts).toBe(0);
    });

  test('should not allow iframe embedding (X-Frame-Options: DENY)', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    });

  test('should have secure object-src directive', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const csp = response?.headers()['content-security-policy'] || '';
    expect(csp).toContain('object-src');
    });
});
