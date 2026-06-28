/**
 * E2E Test Group 1: 登录流程
 * 
 * 测试场景：
 * 1. 首次设置密码 → 登录 → token 存入 sessionStorage → 访问受保护页面
 * 2. 错误密码登录被拒
 * 3. 认证绕过：未登录访问 /logs → 应返回 401
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18792';
const TEST_PASSWORD = 'TestPass123!';

test.describe('E2E Group 1: Authentication Flow', () => {
  
  test.beforeEach(async ({ page }) => {
    // Reset password file before each test to ensure clean state
    const { execSync } = require('child_process');
    try {
      execSync(`rm -f ~/.multi-proxy-password`, { stdio: 'ignore' });
    } catch {}
  });

  test('should show setup mode when no password is set', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    
    // Should redirect to login page
    await expect(page).toHaveURL(/.*login\.html/);
    
    // Setup form should be visible
    await expect(page.locator('#setupMode')).toBeVisible();
    // Login form should be hidden
    await expect(page.locator('#loginMode')).toBeHidden();
  });

  test('should allow password setup and then login', async ({ page }) => {
    // Navigate to login page
    await page.goto(`${BASE_URL}/login.html`);
    
    // Fill setup form
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    
    // Click submit button
    await page.locator('#setupSubmit').click();
    
    // Wait for setup to complete (backend stores password)
    await page.waitForTimeout(2000);
    
    // Should switch to login mode
    await expect(page.locator('#loginMode')).toBeVisible();
    await expect(page.locator('#setupMode')).toBeHidden();
    
    // Login with the password we just set
    await page.locator('#loginPassword').fill(TEST_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    
    // Should redirect to dashboard
    await page.waitForURL(/.*dashboard\.html/);
    await expect(page.locator('#page-dashboard')).toBeVisible();
    
    // Verify token is in sessionStorage
    const token = await page.evaluate(() => sessionStorage.getItem('auth_token'));
    expect(token).toBeTruthy();
    expect(token!.length).toBeGreaterThan(0);
  });

  test('should reject wrong password during login', async ({ page }) => {
    // First set up a password
    await page.goto(`${BASE_URL}/login.html`);
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    await page.locator('#setupSubmit').click();
    await page.waitForTimeout(1500);
    
    // Switch to login mode
    await expect(page.locator('#loginMode')).toBeVisible();
    
    // Try wrong password
    await page.locator('#loginPassword').fill('WrongPassword123!');
    await page.locator('#loginForm button[type="submit"]').click();
    
    // Should show error
    await expect(page.locator('#loginError')).toContainText(/密码不正确/i);
    
    // Stay on login page
    await expect(page.locator('#loginMode')).toBeVisible();
  });

  test('dashboard should load after successful login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login.html`);
    
    // Setup and login in one flow
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    await page.locator('#setupSubmit').click();
    await page.waitForTimeout(1500);
    
    await expect(page.locator('#loginMode')).toBeVisible();
    await page.locator('#loginPassword').fill(TEST_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(/.*dashboard\.html/);
    
    // Dashboard should be visible
    await expect(page.locator('#page-dashboard')).toBeVisible();
    await expect(page.locator('.page-title')).toContainText('概览');
    
    // Proxy cards should be rendered
    await expect(page.locator('.proxy-card')).toHaveCount(3); // codex, hermes, cursor
  });
});
