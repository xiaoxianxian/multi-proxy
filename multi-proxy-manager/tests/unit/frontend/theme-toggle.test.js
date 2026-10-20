// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// D6 守门（2026-10-19 评审 full-e2e §3-P1#2 / §7「补主题切换回归断言」）。
//
// 现状（已 grep 核实，非臆测）：
//   · live 暗色机制 = 在 <html> 上挂 class="dark"，由 localStorage 'darkMode' 键驱动；
//     带 #darkModeToggle 按钮的 6 页（dashboard/knowledge/login/logs/skills/proxy-config）都 wire 了 .dark。
//   · 历史「第 3 套主题」= public/ui.js 的 mp-theme / data-theme，**无任何生产页加载**（全仓 grep 0 引用；docs/ 下无其它 ui.js）。
//
// 本文件锁三条不变量，任一被破坏即「三套主题并存 / 主题又碎裂」回归（2026-08 那个「success/error 颜色不一致」
// 即此类病）：
//   ① live 机制统一：凡带 #darkModeToggle 的页面都 wire 了 <html> 的 .dark class（不出现「有按钮不翻 .dark」）。
//   ② 暗色 token 双选择器兼容：tokens.css 同时覆盖 html[data-theme="dark"]（新）与 html.dark（旧 class），
//      colors_and_type.css 用 :root.dark 覆盖 --color-* 名空间暗色 —— 旧 .dark class 路径不因新 data-theme 失效。
//   ③ 死路径不复活：public/ 生产页无一引用 ui.js，且 public/ui.js 已删（OD-4 老板拍板=删）；
//      若日后有人重新加回 ui.js 或挂回生产页，本断言 fail，需有意的决策才更新。
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', '..', 'public'); // tests/unit/frontend → 3 级到 manager 根 → public
// 独立主题 / 品牌门 / 重定向页，不走统一 darkMode 机制，豁免（consent=OD-5 独立品牌门，legal 无暗色，index=重定向）
const THEME_EXEMPT = new Set(['consent.html', 'legal.html', 'index.html']);

function readSrc(f) { return fs.readFileSync(path.join(PUB, f), 'utf8'); }

describe('D6 主题机制回归（防「三套主题并存」复发）', () => {
  test('① 凡带 #darkModeToggle 的页面都 wire 了 <html> 的 .dark class（live 机制不碎裂）', () => {
    const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html') && !THEME_EXEMPT.has(f));
    const offenders = [];
    pages.forEach((f) => {
      const h = readSrc(f);
      // 有暗色按钮、却没在 <html> 上操作 .dark class → 碎了一处
      if (h.includes('id="darkModeToggle"') &&
          !/classList\.(add|remove|toggle)\(\s*['"]dark['"]\s*\)/.test(h)) {
        offenders.push(f);
      }
    });
    expect(offenders).toEqual([]);
  });

  test('② 暗色 token 块同时覆盖 html[data-theme="dark"]（新）与 html.dark（旧 class），旧路径不失效', () => {
    const tokens = readSrc('tokens.css');
    expect(tokens).toMatch(/html\[data-theme=["']dark["']\]/); // 新 key
    expect(tokens).toMatch(/html\.dark/);                        // 旧 class（兼容）
    const colorsAndType = readSrc('colors_and_type.css');
    expect(colorsAndType).toMatch(/:root\.dark/);                  // --color-* 名空间的暗色桥接
  });

  test('③ public/ui.js 已删（OD-4 拍板=删），生产页无一引用 ui.js（mp-theme/data-theme 第 3 套不复活）', () => {
    const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
    const offenders = [];
    pages.forEach((f) => {
      if (/<script[^>]*\ssrc=["'][^"']*\/?ui\.js["']/i.test(readSrc(f))) offenders.push(f);
    });
    expect(offenders).toEqual([]);
    // OD-4=删：ui.js 文件本身不存在；重新加回=回归，需有意的决策才解锁本断言
    expect(fs.existsSync(path.join(PUB, 'ui.js'))).toBe(false);
  });
});
