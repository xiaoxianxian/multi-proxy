// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * Shared helpers for E2E tests — P1 regen (10-16).
 *
 * 根因(查实 07:xx 10-16): login.html 加载即 `fetch('/api/auth/status')` → 按 `needsSetup`
 * 选双态: needsSetup=true(无密码/fresh)→ #setupMode(默认显)。false → #loginMode;
 * 设置密码成功即 `store token` 并 `auto-redirect` 到 dashboard(无中间 login 态)。
 * 矩阵旧版没等这段渲染 + 误假设「设置→显 login 态」, 直接点 `#setupPassword` 落在 hidden
 * 容器 → `not visible` = 测试脆, 非 v1.0 回归。本 P1 用「读 status JSON 选态 + 等 mode 渲染」根治。
 *
 * P0 安全(10-16)保留: 仅 throwaway HOME(MP_TEST_HOME 设)才 reset 密码; real HOME 下 no-op。
 * 真凭据在 ~/.multi-proxy-manager/password(+ jwt ~/.multi-proxy-jwt-secret), 绝不删。
 */

import { Page, expect } from '@playwright/test';

// P0 安全(10-16): 永不默认生产 18792; 矩阵须参数化隔离端口(18801), 绝不撞真实 manager。
export const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:18801';
// 12 字符, 满足 setupForm 的「≥8 字符」约束(login.html:1040)。
export const TEST_PASSWORD = 'TestPass123!';

// P0 安全(10-16): 仅 throwaway HOME 清密码; real HOME no-op, 绝不清真凭据。
function resetThrowawayPassword() {
  try {
     // 真凭据在 ~/.multi-proxy-manager/password(+ jwt ~/.multi-proxy-jwt-secret)。
    if (process.env.MP_TEST_HOME) {
      const { execSync } = require('child_process');
      execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/password"`, { stdio: 'ignore' });
    }
   } catch { /* no throwaway → no-op */ }
}

// fresh(无密码)→ 设置密码一步到位(设置即 store token 并 auto-redirect 到 dashboard)。
// race-free: 注册 status 响应监听后再 goto, 按 needsSetup 选态, 不靠 mode 渲染时序。
export async function login(page: Page, password: string = TEST_PASSWORD): Promise<string> {
  resetThrowawayPassword();
  const statusResp = page.waitForResponse(r => r.url().includes('/api/auth/status'));
  await page.goto(`${BASE_URL}/login.html`);
  const status = await (await statusResp).json();
  const loginResp = page.waitForResponse(r => r.url().includes('/api/auth/login'));

  if (status.needsSetup) {
     // P1: 等 #setupMode 渲染(默认显, 但 fresh 下也保险等一拍)。
    await expect(page.locator('#setupMode')).toBeVisible();
    await page.locator('#setupPassword').fill(password);
    await page.locator('#setupConfirm').fill(password);
    await page.locator('#setupSubmit').click();
   } else {
      // P1: 等 #loginMode 渲染(有密码 → login 态, toBeVisible 自带 auto-wait 覆盖 mode 切换)。
     await expect(page.locator('#loginMode')).toBeVisible();
     await page.locator('#loginPassword').fill(password);
     await page.locator('#loginForm button[type="submit"]').click();
   }

  await loginResp;
  await page.waitForURL(/.*dashboard\.html/);
  const token = await page.evaluate(() => sessionStorage.getItem('auth_token'));
  return token || '';
}

// 01 T3 用: 清 token 回「需登录」, 配合已存在的密码 → on-load 会进 login 态。
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => sessionStorage.removeItem('auth_token'));
}
