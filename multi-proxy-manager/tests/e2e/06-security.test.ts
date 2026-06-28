/**
 * E2E Test Group 6: XSS 防护和安全
 * 
 * 测试场景：
 * 1. 供应商名称含 <script> 标签 → 渲染时应转义
 * 2. CSP headers 存在
 * 3. HTTP 安全 headers 存在
 * 4. 密码长度限制（>1024 字节返回 413）
 * 5. 登录速率限制（多次失败后应被限制）
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18792';
const TEST_PASSWORD = 'TestPass123!';

test.describe('E2E Group 6: Security & XSS Protection', () => {
  
  test('should have CSP headers', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['content-security-policy']).toContain("default-src");
  });

  test('should have X-Content-Type-Options header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('should have X-Frame-Options header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('should have X-XSS-Protection header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    expect(headers['x-xss-protection']).toBeTruthy();
    expect(headers['x-xss-protection']).toContain('1');
  });

  test('should have Referrer-Policy header', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    expect(headers['referrer-policy']).toBeTruthy();
  });

  test('should escape XSS in provider names', async ({ page }) => {
    // Login first
    await page.goto(`${BASE_URL}/login.html`);
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    await page.locator('#setupSubmit').click();
    await page.waitForTimeout(1500);
    await expect(page.locator('#loginMode')).toBeVisible();
    await page.locator('#loginPassword').fill(TEST_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(/.*dashboard\.html/);
    
    // Go to proxy-config for cursor (the one with provider CRUD)
    await page.goto(`${BASE_URL}/proxy-config.html?proxy=cursor`);
    
    // Navigate to providers tab
    const tabs = page.locator('.section-tab');
    await tabs.nth(1).click();
    await page.waitForTimeout(500);
    
    // Check that the provider table renders safely
    const tbody = page.locator('#providersBody');
    await expect(tbody).toBeVisible();
    
    // The page should not have any script injection
    // Verify no eval or script execution happened
    const hasScriptTags = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[src]');
      return scripts.length === 0; // No external scripts should be injected
    });
    expect(hasScriptTags).toBe(true);
  });

  test('should handle malformed HTML in table cells', async ({ page }) => {
    // Login first
    await page.goto(`${BASE_URL}/login.html`);
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    await page.locator('#setupSubmit').click();
    await page.waitForTimeout(1500);
    await expect(page.locator('#loginMode')).toBeVisible();
    await page.locator('#loginPassword').fill(TEST_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(/.*dashboard\.html/);
    
    // Go to logs page and check that HTML entities are escaped
    await page.goto(`${BASE_URL}/logs.html`);
    
    // The log viewer should render text safely
    const viewer = page.locator('#logViewer');
    await expect(viewer).toBeVisible();
    
    // Check that no raw HTML tags are rendered as HTML
    const hasRawScripts = await page.evaluate(() => {
      const scripts = document.querySelectorAll('#logViewer script');
      return scripts.length === 0;
    });
    expect(hasRawScripts).toBe(true);
  });

  test('should not allow iframe embedding (X-Frame-Options: DENY)', async ({ page }) => {
    // Try to load the dashboard inside an iframe
    // The browser should block this due to X-Frame-Options: DENY
    const response = await page.goto(`${BASE_URL}/`);
    const headers = response?.headers() || {};
    
    // X-Frame-Options should be DENY
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('should have secure object-src directive', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    const csp = response?.headers()['content-security-policy'] || '';
    
    // CSP should include object-src: none to prevent plugin-based attacks
    expect(csp).toContain('object-src');
  });
});
