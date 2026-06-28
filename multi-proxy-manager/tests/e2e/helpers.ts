/**
 * Shared helpers for E2E tests
 */

import { Page, expect } from '@playwright/test';

const TEST_PASSWORD = 'TestPass123!';
const BASE_URL = 'http://localhost:18792';

/**
 * Helper: Login via the web UI. Sets up password if needed, then logs in.
 * Returns the auth token from sessionStorage.
 */
export async function login(page: Page): Promise<string> {
  const { execSync } = require('child_process');
  try {
    execSync(`rm -f ~/.multi-proxy-password`, { stdio: 'ignore' });
  } catch {}

  await page.goto(`${BASE_URL}/login.html`);
  
  // Check if we're in setup mode or login mode
  const isSetupMode = await page.locator('#setupMode').isVisible().catch(() => false);
  
  if (isSetupMode) {
    await page.locator('#setupPassword').fill(TEST_PASSWORD);
    await page.locator('#setupConfirm').fill(TEST_PASSWORD);
    await page.locator('#setupForm').click();
    await page.waitForTimeout(2000);
    await expect(page.locator('#loginMode')).toBeVisible();
  }
  
  await page.locator('#loginPassword').fill(TEST_PASSWORD);
  await page.locator('#loginForm').click();
  await page.waitForURL(/.*dashboard\.html|.*logs\.html|.*proxy-config\.html/);
  
  const token = await page.evaluate(() => sessionStorage.getItem('auth_token'));
  return token || '';
}

/**
 * Helper: Logout by clearing sessionStorage
 */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => sessionStorage.removeItem('auth_token'));
}
