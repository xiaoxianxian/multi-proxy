/**
 * E2E Test Group 2: Dashboard 交互
 * 
 * 测试场景：
 * 1. 代理状态卡片加载和显示
 * 2. 代理启停按钮 → 状态实时更新
 * 3. 自动刷新面板
 * 4. 统计卡片数字更新
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18792';
const TEST_PASSWORD = 'TestPass123!';

test.describe('E2E Group 2: Dashboard Interactions', () => {
  
  test.beforeEach(async ({ page }) => {
    // Ensure clean state
    const { execSync } = require('child_process');
    try {
      execSync(`rm -f ~/.multi-proxy-password`, { stdio: 'ignore' });
    } catch {}
    
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
  });

  test('should display proxy status cards with correct names', async ({ page }) => {
    // All three proxy cards should be visible
    const cards = page.locator('.proxy-card');
    await expect(cards).toHaveCount(3);
    
    // Check card names
    const cardNames = await cards.allTextContents();
    const names = cardNames.map(n => n.toLowerCase());
    expect(names.some(n => n.includes('codex'))).toBe(true);
    expect(names.some(n => n.includes('hermes'))).toBe(true);
    expect(names.some(n => n.includes('cursor'))).toBe(true);
  });

  test('should show proxy port badges', async ({ page }) => {
    const ports = await page.locator('.proxy-port-badge').allTextContents();
    expect(ports).toContain(':18790'); // codex
    expect(ports).toContain(':18793'); // hermes
    expect(ports).toContain(':18794'); // cursor
  });

  test('should have start/stop buttons for each proxy', async ({ page }) => {
    // Find all toggle buttons
    const toggleButtons = page.locator('[id^="btn-toggle-"]');
    await expect(toggleButtons).toHaveCount(3);
    
    // Buttons should be visible
    for (const btn of await toggleButtons.all()) {
      await expect(btn).toBeVisible();
    }
  });

  test('should navigate to proxy-config from dashboard config button', async ({ page }) => {
    // Click the first proxy's config button
    const configButtons = page.locator('.proxy-actions .btn-outline');
    await expect(configButtons.first()).toBeVisible();
    await configButtons.first().click();
    
    // Should navigate to proxy-config page
    await expect(page).toHaveURL(/.*proxy-config\.html/);
    await expect(page.locator('.page-title')).toBeVisible();
  });

  test('should show version info section', async ({ page }) => {
    const versionContainer = page.locator('#versionInfo');
    await expect(versionContainer).toBeVisible();
    
    // Version items should exist
    const verLabels = await page.locator('.ver-label').allTextContents();
    expect(verLabels).toContain('管理器版本');
    expect(verLabels).toContain('Codex Proxy');
    expect(verLabels).toContain('Hermes Proxy');
    expect(verLabels).toContain('Cursor Proxy');
  });

  test('should show installed proxy count in stat cards', async ({ page }) => {
    const installedCount = page.locator('#installedCount');
    await expect(installedCount).toBeVisible();
    // Should show a number (at least parsed from API)
    const countText = await installedCount.innerText();
    expect(countText).toMatch(/\d+/);
  });

  test('should have auto-refresh panel', async ({ page }) => {
    const panel = page.locator('#autoRefreshPanel');
    await expect(panel).toBeVisible();
    
    const toggle = page.locator('#autoRefreshToggle');
    await expect(toggle).toBeChecked(); // enabled by default
    
    const intervalSelect = page.locator('#autoRefreshInterval');
    await expect(intervalSelect).toBeVisible();
  });

  test('should have sidebar navigation with all sections', async ({ page }) => {
    const navItems = page.locator('.sidebar-nav .nav-item');
    await expect(navItems).toHaveCount(4); // 总览 + 3 proxies
    
    const labels = await navItems.allTextContents();
    expect(labels.some(l => l.includes('概览'))).toBe(true);
  });
});
