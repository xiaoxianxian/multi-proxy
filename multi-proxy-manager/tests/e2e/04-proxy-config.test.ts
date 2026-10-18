// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E Test Group 4: Proxy Config 页面(codex)— P1/P2 regen (10-16, v3)。
 *
 * P1 根因(查实 07:xx 10-16, 以 throwaway probe 为准):
 *  - beforeEach 旧「setup→等#loginMode→手动 login」+ `rm ~/.multi-proxy-password`(错路径碰 real)
 *    → 改 helpers.login()(race-free)+ 仅 throwaway 清密码。
 *  - proxy-config.html 无 `.page-title` → 用 `.section-tab` 作页面加载信号。
 *  - codex 的「供应商」「余额」tab 是 `<div disabled>`(proxy-config.html:576/578)。div 不上
 *    Playwright toBeDisabled()(非 form control 报 "enabled"), 须断 HTML 属性 `toHaveAttribute('disabled')`。
 *  - tab 切换走 hash(switchTab → history.replaceState('#tab') + on-load getTabFromHash),
 *    #modelSelect/#routingModeSelect 由 renderModels/异步 config fetch 填充 → 须等。切 tab 用
 *    hash URL(真实机制), 不靠会被浮层拦截的按钮 click。
 * P0 安全(10-16): BASE_URL 默认 18801; beforeEach 仅 throwaway 清密码, 不碰真凭据。
 */

import { test, expect } from '@playwright/test';
import { login, BASE_URL } from './helpers';

const PC = `${BASE_URL}/proxy-config.html?proxy=codex`;

test.describe('E2E Group 4: Proxy Config Page (codex)', () => {

    // P0 安全(10-16): 仅 throwaway HOME(MP_TEST_HOME)清密码; real HOME no-op, 不碰真凭据。
  test.beforeEach(async ({ page }) => {
    try {
      if (process.env.MP_TEST_HOME) {
        const { execSync } = require('child_process');
        execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/password"`, { stdio: 'ignore' });
       }
     } catch { /* no throwaway → no-op */ }
      // P1: 设置密码即 auto-redirect dashboard; 再手动进 codex 的 proxy-config 页。
    await login(page);
    await page.goto(PC);
    });

  test('should load the codex proxy config page (config tab active)', async ({ page }) => {
      // P1: 默认落配置 tab; 活动 proxy 在 nav 高亮。
    await expect(page.locator('.section-tab').first()).toBeVisible();
    await expect(page.locator('.sidebar-nav .nav-item').filter({ hasText: 'Codex' })).toBeVisible();
    await expect(page.locator('#tab-config')).toBeVisible();
    });

  test('should have section tabs (config / providers / models / balances)', async ({ page }) => {
    const tabs = page.locator('.section-tab');
    await expect(tabs).toHaveCount(4);
    const tabLabels = await tabs.allTextContents();
    expect(tabLabels).toContain('配置');
    expect(tabLabels).toContain('供应商');
    expect(tabLabels).toContain('模型');
    expect(tabLabels).toContain('余额');
    });

  test('should switch to the models tab', async ({ page }) => {
      // 10-18 解除 skip: HEAD 的 renderBalances 字符串越界致整页 <script> 解析失败 →
      // switchTab 不存在, 所有 tab 切不动。b44bf8f 修复后恢复真跑。
    await page.goto(`${PC}#models`);
    await expect(page.locator('#tab-models')).toBeVisible();
    });

  test('should persist tab selection in URL hash', async ({ page }) => {
      // P1: hash 是切换的持久化机制; 载入 #models 后 url 落 #models。
    await page.goto(`${PC}#models`);
    expect(page.url()).toContain('#models');
    });

  test('should render provider tab disabled for codex', async ({ page }) => {
      // P1: div 不上 toBeDisabled; 断 HTML disabled 属性(供应商对 codex 不可用)。
    await expect(page.locator('#tab-providers-btn')).toHaveAttribute('disabled', '');
    });

  test('should render balance tab disabled for codex', async ({ page }) => {
      // P1: 余额对 codex 不可用 → disabled 属性。
    await expect(page.locator('#tab-balances-btn')).toHaveAttribute('disabled', '');
    });

  test('should keep provider table body in DOM (empty when unsupported)', async ({ page }) => {
      // P1: 供应商 panel 在 DOM(隐藏), body 恒渲染; 不断 visible(面板 disabled 不可达)。
    expect(await page.locator('#providersBody').count()).toBeGreaterThan(0);
    });

  test('should populate model selection in models tab', async ({ page }) => {
      // 10-18 解除 skip: #modelSelect 在 #tab-models 内, 依赖 tab 切换;
      // b44bf8f 修复后面板可达。
    await page.goto(`${PC}#models`);
    await expect(page.locator('#modelSelect')).toBeVisible({ timeout: 15000 });
    });

  test('should keep balance grid in DOM (hidden when unsupported)', async ({ page }) => {
      // P1: 余额 grid 在 DOM(隐藏面板内), 断存在即可。
    expect(await page.locator('#balanceGrid').count()).toBeGreaterThan(0);
    });

  test('should hide routing mode and show switch-history for codex (by design)', async ({ page }) => {
      // 原断言「routing mode 可见」与 by-design 冲突: routing mode 仅 cursor 有,
      // #routingModeItem HTML 默认 display:none(proxy-config.html:595),
      // setupRoutingModeVisibility(:1094) 只对 cursor 放开; codex 的对应 UI
      // 是「切换历史」表(#historyBody)。10-18 按设计行为改写(待拍板项②闭环)。
    await expect(page.locator('#routingModeItem')).toBeHidden();
    await expect(page.locator('#historyBody')).toBeVisible({ timeout: 15000 });
    });

  test('should have start/stop button for proxy', async ({ page }) => {
      // P1: 在跑代理(codex running)→ 按钮文本「停止」。
    const btn = page.locator('#btnStartStop');
    await expect(btn).toBeVisible();
    expect((await btn.innerText()).trim()).toBeTruthy();
    });

  test('should stay navigable across tab switches', async ({ page }) => {
      // 10-18 解除 skip: 依赖 tab 切换, b44bf8f 修复后恢复真跑。
    await page.goto(`${PC}#models`);
    await expect(page.locator('#tab-models')).toBeVisible();
    });

  test('should navigate back to dashboard', async ({ page }) => {
      // P1: 「返回概览」是真实 <a href=dashboard.html>(proxy-config.html:511)。
    await page.locator('.sidebar-nav a.nav-item[href="dashboard.html"]').click();
    await page.waitForURL(/.*dashboard\.html/);
    await expect(page.locator('#page-dashboard')).toBeVisible();
    });
});
