// multi-proxy E2E smoke（v1.0 收口）
// 7 个壳页真浏览器加载断言：能渲染 + 有标题 + 无 pageerror（致命 JS 异常）。
// 口径克制：不依赖具体业务选择器（避免与 1529 jest 重复），只验「真浏览器加载不崩」。
// functional 交互 E2E（点按钮/调 API）为后续独立任务，不在本 smoke 范围。
const { test, expect } = require('@playwright/test');

// 统一壳页（带侧栏 .nav）；login/consent 是独立 overlay，不在此列（由 jest login/consent suite 覆盖）
const shellPages = [
  '/dashboard',
  '/floor',
  '/logs',
  '/sessions',
  '/knowledge',
  '/skills',
  '/settings',
];

for (const route of shellPages) {
  test(`${route} 在真浏览器能渲染、不崩`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // 静默 fetch 失败噪声（file 测试不关心 API 是否连通，只关心页面本身渲染）
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    // 用 auto-waiting 断言（等真渲染，最多 15s）；别用固定 sleep：
    // /logs 等初始化含冲突检测 app.js + rate-limit，初始化 >800ms，固定 snapshot 会变 flaky。
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
    const text = await page.locator('body').innerText();
    expect(text.trim().length, 'body 文本应非空（真渲染，非白屏）').toBeGreaterThan(20);

    // ② 有标题（文档 title 非空）
    const title = await page.title();
    expect(title.trim().length, 'document.title 应非空').toBeGreaterThan(0);

    // ③ 无 pageerror（致命 JS 异常 → 页面崩）；fetch 404 不算 pageerror
    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}
