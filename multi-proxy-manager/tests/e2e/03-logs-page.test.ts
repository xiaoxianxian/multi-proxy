// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E Test Group 3: Logs 页面 — P1 regen (10-16).
 *
 * P1 根因(查实 07:xx 10-16):
 *  1) 旧 beforeEach 走「setup → 等 #loginMode → 手动 login」旧流 + `rm ~/.multi-proxy-password`
 *     (错路径且碰 real HOME)。改 helpers.login()(race-free)+ 仅 throwaway 清密码。
 *  2) #logCount 元素实为 null(空/不存在) → 旧断言其 visible 挂。真实空态是
 *     #logViewer 里「暂无日志…」占位。改断 viewer + 占位文本。
 * P0 安全(10-16): BASE_URL 默认隔离端口 18801; beforeEach 仅 throwaway HOME 清密码, 不碰真凭据。
 */

import { test, expect } from '@playwright/test';
import { login, BASE_URL } from './helpers';

test.describe('E2E Group 3: Logs Page', () => {

    // P0 安全(10-16): 仅 throwaway HOME(MP_TEST_HOME)清密码; real HOME no-op, 不碰真凭据。
  test.beforeEach(async ({ page }) => {
    try {
      if (process.env.MP_TEST_HOME) {
        const { execSync } = require('child_process');
        execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/password"`, { stdio: 'ignore' });
        // P3(10-19): 代理写流量(lib/forward.js:177)会持续累积 requests.log, 一并清掉恢复空态起点; real HOME no-op。
        execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/logs/requests.log"`, { stdio: 'ignore' });
       }
     } catch { /* no throwaway → no-op */ }
      // P1: 设置密码即 auto-redirect dashboard; 再手动进 logs 页。
    await login(page);
    await page.goto(`${BASE_URL}/logs.html`);
    });

  test('should load and display logs', async ({ page }) => {
     // P1: 等日志 viewer 渲染(异步); P3(10-19): 空态占位为主, 但运行中代理可自动重建日志文件, 真实日志行同为有效渲染。
    await expect(page.locator('#logViewer')).toBeVisible();
    await expect(page.locator('#logViewer')).toContainText(/暂无日志|INFO|ERROR|WARN/i, { timeout: 10000 });
    });

  test('should have proxy filter dropdown', async ({ page }) => {
    await expect(page.locator('#proxyFilter')).toBeVisible();
    const options = await page.locator('#proxyFilter option').allTextContents();
    expect(options).toContain('全部代理');
    expect(options.some(o => o.includes('Codex'))).toBe(true);
    expect(options.some(o => o.includes('Hermes'))).toBe(true);
    expect(options.some(o => o.includes('Cursor'))).toBe(true);
    });

  test('should have level filter dropdown', async ({ page }) => {
    await expect(page.locator('#levelFilter')).toBeVisible();
    const options = await page.locator('#levelFilter option').allTextContents();
    expect(options).toContain('全部级别');
    expect(options.some(o => o.includes('INFO'))).toBe(true);
    expect(options.some(o => o.includes('ERROR'))).toBe(true);
    expect(options.some(o => o.includes('WARN'))).toBe(true);
    });

  test('should have search input', async ({ page }) => {
     // P1: 占位符实为「搜索日志…」。
    const search = page.locator('#logSearch');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', '搜索日志...');
    await search.fill('error');
    await page.waitForTimeout(500);
      // P1: 断 viewer 仍渲染(过滤后), 不断不存在的 #logCount。
    await expect(page.locator('#logViewer')).toBeVisible();
    });

  test('should have time range buttons', async ({ page }) => {
     // P1: 4 个时间按钮实为 1h/6h/24h/全部(hours 0), 逐字命中。
    const timeButtons = page.locator('.time-range-btn');
    await expect(timeButtons).toHaveCount(4);
    const labels = await timeButtons.allTextContents();
    expect(labels).toContain('1小时');
    expect(labels).toContain('6小时');
    expect(labels).toContain('24小时');
    expect(labels).toContain('全部');
      // P1: data-hours="0" 才是「全部」; 点它(非 1h)。
    await page.locator('.time-range-btn[data-hours="0"]').click();
    });

  test('should have refresh button', async ({ page }) => {
    await expect(page.locator('#refreshBtn')).toBeVisible();
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(500);
      // P1: 刷新后 viewer 仍渲染。
    await expect(page.locator('#logViewer')).toBeVisible();
    });

  test('should have export capability', async ({ page }) => {
     // P1: 导出走 window.exportLogs 函数(2 个 onclick 也命中), 断能力存在即可(不写死可见按钮)。
    const hasExport = await page.evaluate(() => {
      return typeof (window as any).exportLogs === 'function' ||
        document.querySelectorAll('[onclick*="export"]').length > 0;
    });
    expect(hasExport).toBe(true);
    });

  test('should have auto-refresh toggle', async ({ page }) => {
     // P1: 自动刷新按钮实文本「自动刷新」。
    const autoRefreshBtn = page.locator('#autoRefreshBtn');
    await expect(autoRefreshBtn).toBeVisible();
    await autoRefreshBtn.click();
    await page.waitForTimeout(300);
    const btnText = await autoRefreshBtn.innerText();
    expect(btnText).toBeTruthy();
    });

  test('should navigate between logs and dashboard', async ({ page }) => {
      // P1: logs.html 的「概览」nav 是 data-page 切换器(非 <a> 跳转, logs.html:664/1305),
    // 点击只置 active, 不会跳 dashboard.html。dashboard 是独立文件, 直接可达(登录后 token
    // 在 sessionStorage, 同源跨页共享)。验证: nav 可点 + dashboard 直接可达并渲染。
    const overviewNav = page.locator('.sidebar-nav .nav-item[data-page="dashboard"]');
    await expect(overviewNav).toBeVisible();
    await overviewNav.click();
    await expect(overviewNav).toHaveClass(/active/);
    await page.goto(`${BASE_URL}/dashboard.html`);
    await expect(page.locator('#page-dashboard')).toBeVisible();
    });
});
