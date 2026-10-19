// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 守门：首启 / 可见页禁止把 Markdown 语法（**、反引号强调等）写进可见文案，
// 否则浏览器原样露出 `**`（2026-10-19 老板截图投诉根因：consent.html:59 / skills.html:157）。
// 只校验「可见标记文本」——HTML 注释、<script> 块、<code> 代码段里的星号不渲染，不算污染。
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'public');
// 用户首启/高频可见页（新增可见静态页请在此登记，免再漏网）
const VISIBLE_PAGES = ['consent.html', 'skills.html'];

function visibleText(html) {
  let t = html;
  t = t.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');   // 连内部 // 与 /* *\/ 注释一并剔除
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');                 // HTML 注释
  t = t.replace(/<code\b[\s\S]*?<\/code>/gi, ' ');        // 合法代码段
  return t;
}

describe('首启/可见页 不渲染 Markdown 语法（防字面 ** 露出）', () => {
  test.each(VISIBLE_PAGES)('%s 可见文案无 literal **', (file) => {
    const raw = fs.readFileSync(path.join(PUB, file), 'utf8');
    const hits = [];
    visibleText(raw)
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('**')) hits.push(`L${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    expect(hits).toEqual([]);
  });

  test('同意页 .btn 链接样式含 text-decoration:none（防 <a class=btn> 默认下划线）', () => {
    const raw = fs.readFileSync(path.join(PUB, 'consent.html'), 'utf8');
    expect(raw).toMatch(/\.btn\{[^}]*text-decoration\s*:\s*none/);
  });
});
