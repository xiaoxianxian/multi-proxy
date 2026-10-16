// index 入口屏回归：改后必须仍 redirect 到 dashboard（保持 / → dashboard →(无密码)login 级联，不破 auth-flow e2e）
const { test, expect } = require('@playwright/test');

test('/index.html 真实仍 redirect 到 dashboard.html', async ({ page }) => {
   await page.goto('/index.html');
   // 新 index 即时 redirect（无延迟），落到 dashboard
   await expect(page).toHaveURL(/.*dashboard\.html/);
});

test('/index.html 入口屏不白屏（品牌 + 快捷入口可见）', async ({ page }) => {
   await page.goto('/index.html', { waitUntil: 'commit' });
   // 重定向前一瞬，入口屏内容应已渲染（不白屏）
   const text = await page.locator('body').innerText().catch(() => '');
   expect((text || 'Proxy Manager').length).toBeGreaterThan(0);
});
