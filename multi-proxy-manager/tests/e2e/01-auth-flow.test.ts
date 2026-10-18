// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E Test Group 1: 登录流程 — P1 regen (10-16).
 *
 * 场景:
 * 1. fresh(无密码)→ setup 态(设置密码 → store token → auto-redirect dashboard)
 * 2. 错误密码被拒(服务端 401 → 客户端 #loginError「Invalid password」)
 * 3. 设置/登录成功 → dashboard + token 在 sessionStorage
 *
 * P1 根因(查实 07:xx 10-16): 旧矩阵没等 on-load `/api/auth/status` 双态渲染, 且误假设
 * 「设置 → 显 login 态 → 再输密码」。当前 login.html 设置成功即 auto-redirect dashboard、
 * 无中间 login 态。旧断言 #loginMode / `.proxy-card==3` 全部 stale。
 *
 * P0 安全(10-16): BASE_URL 默认隔离端口 18801(非生产 18792); beforeEach 仅 throwaway
 * HOME 清密码, 绝不动真 ~/.multi-proxy-manager 凭据。
 */

import { test, expect } from '@playwright/test';
import { login, logout, BASE_URL, TEST_PASSWORD } from './helpers';

test.describe('E2E Group 1: Authentication Flow', () => {
   // P0 安全(10-16): 仅 throwaway HOME(MP_TEST_HOME)清密码; real 下 no-op, 不碰真凭据。
  test.beforeEach(async () => {
    try {
      if (process.env.MP_TEST_HOME) {
        const { execSync } = require('child_process');
        execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/password"`, { stdio: 'ignore' });
      }
    } catch { /* no throwaway → no-op */ }
   });

  test('should show setup mode when no password is set', async ({ page }) => {
   // P1: 等 on-load render 落到 setup 态(fresh → needsSetup=true)。
    await page.goto(`${BASE_URL}/login.html`);
    await expect(page.locator('#setupMode')).toBeVisible();
    await expect(page.locator('#loginMode')).toBeHidden();
   });

  test('should allow password setup and then login', async ({ page }) => {
   // P1: 当前 login.html 设置密码即 store token 并 auto-redirect 到 dashboard(无中间 login 态)。
    const token = await login(page);
    await expect(page).toHaveURL(/.*dashboard\.html/);
    expect(token, 'token 应存入 sessionStorage(设置即登录)').toBeTruthy();
    expect(token.length).toBeGreaterThan(0);
   });

  test('should reject wrong password during login', async ({ page }) => {
   // 先设密码 → dashboard(密码此刻已在服务端); 清 token 回「需登录」→ 再进 login 态。
    await login(page);
    await logout(page);
    await page.goto(`${BASE_URL}/login.html`);
    // P1: 等 #loginMode 渲染(已存在密码 → on-load needsSetup=false → login 态)。
    await expect(page.locator('#loginMode')).toBeVisible();

     // 错误密码(服务端 401 → 客户端 #loginError「Invalid password」, auth.js:60/79)。
    await page.locator('#loginPassword').fill('WrongPassword123!');
    const resp = page.waitForResponse(r => r.url().includes('/api/auth/login'));
    await page.locator('#loginForm button[type="submit"]').click();
    await resp;

    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#loginError')).toContainText(/invalid password/i);
    // 仍在 login 页(未跳转)。
    await expect(page.locator('#loginMode')).toBeVisible();
   });

  test('dashboard should load after successful login', async ({ page }) => {
   // P1: 单步 setup → dashboard(设置即登录)。
    await login(page);
    await expect(page.locator('#page-dashboard')).toBeVisible();
      // P1: dashboard 是 SPA, .page-title 同时命中 8 个 section; 须 scope 到 dashboard 自身的标题。
    await expect(page.locator('#page-dashboard h1.page-title')).toContainText('概览');
      // P1: 代理卡片异步轮询 /api/installed/health; 等首张卡渲染(在跑代理下应出现)。
    await expect(page.locator('.proxy-card').first()).toBeVisible({ timeout: 15000 });
       // 数量随在跑代理变(throwaway: Codex+Hermes); 只断「≥1 张卡渲染」, 不写死 3。
    const cards = await page.locator('.proxy-card').count();
    expect(cards, '代理卡片应渲染(≥1, 数量随在跑代理变)').toBeGreaterThan(0);
   });
});
