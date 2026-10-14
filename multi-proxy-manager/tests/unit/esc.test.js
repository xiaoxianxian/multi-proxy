// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * esc() XSS 防护测试（§F 收尾：dashboard esc() 用例）。
 *
 * 覆盖两层：
 *   1. tests/unit/helpers/esc.js（纯 Node 实现）的行为正确性；
 *   2. 7 个前端 HTML 里的 esc() 源码契约——每个文件必须仍然包含完整的
 *      转义策略（DOM 式 textContent→innerHTML + " ' 两条补充替换，
 *      或等价的正则五替换），防止某次改动把某个页面的转义弄丢。
 *
 * 已知无害差异：助手把 ' 编码为 &#039;，浏览器 DOM 式编码为 &#39;，
 * 两者都是合法 HTML 实体且都不可逃逸，属外观差异不做强一致。
 */

const fs = require('fs');
const path = require('path');
const { esc } = require('./helpers/esc');

describe('esc() — 基础实体编码', () => {
  test('五个 HTML 元字符全部转义', () => {
    expect(esc('&')).toBe('&amp;');
    expect(esc('<')).toBe('&lt;');
    expect(esc('>')).toBe('&gt;');
    expect(esc('"')).toBe('&quot;');
    expect(esc("'")).toBe('&#039;');
  });

  test('混合字符串逐字符保留顺序', () => {
    expect(esc('a<b>&c"d\'e')).toBe('a&lt;b&gt;&amp;c&quot;d&#039;e');
  });

  test('& 必须最先替换（防二重编码回归）', () => {
    // 若替换顺序被改成先 < 后 &，"<" 会变成 "&amp;lt;"——可读但等于没转义
    expect(esc('<')).toBe('&lt;');
    expect(esc('<>&')).toBe('&lt;&gt;&amp;');
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  test('空串与无元字符串原样返回', () => {
    expect(esc('')).toBe('');
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  test('中文与 emoji 原样通过（不被误伤）', () => {
    expect(esc('你好，世界')).toBe('你好，世界');
    expect(esc('部署✅完成')).toBe('部署✅完成');
  });

  test('长字符串不丢内容', () => {
    const long = '<script>'.repeat(1000);
    const out = esc(long);
    expect(out).not.toContain('<script>');
    expect(out.length).toBe('<script>'.length * 1000 + 1000 * ('&lt;'.length - 1) + 1000 * ('&gt;'.length - 1));
  });
});

describe('esc() — 类型守卫', () => {
  test('非字符串输入一律返回空串', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('');
    expect(esc({ a: 1 })).toBe('');
    expect(esc(['<b>'])).toBe('');
    expect(esc(true)).toBe('');
  });

  test('数字 0 / false 等 falsy 非字符串同样返回空串', () => {
    expect(esc(0)).toBe('');
    expect(esc(false)).toBe('');
    expect(esc(NaN)).toBe('');
  });
});

describe('esc() — XSS 载荷语料', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "'-alert(1)-'",
    '<iframe src="javascript:alert(1)">',
    '</script><script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
    '<input onfocus=alert(1) autofocus>',
    '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
    '<form><button formaction=javascript:alert(1)>x',
  ];

  // 安全不变量（正确口径）：转义后不存在裸尖括号与裸引号。
  // javascript: / onmouseover= 等字样可作为纯文本残留——标签已被实体化，它们无害。
  const assertInert = (out) => {
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
  };

  test.each(payloads)('载荷被中性化：%s', (p) => {
    assertInert(esc(p));
  });

  test('含 < 的载荷必然发生尖括号转义', () => {
    for (const p of payloads.filter(x => x.includes('<'))) {
      expect(esc(p)).toContain('&lt;');
    }
  });

  test('引号载荷发生引号转义', () => {
    expect(esc('"-alert(1)-"')).toContain('&quot;');
    expect(esc("'-alert(1)-'")).toContain('&#039;');
  });

  test('on* 事件处理器失去标签挂点', () => {
    const out = esc('<div onmouseover="alert(1)">hover</div>');
    assertInert(out);
    expect(out).toContain('&lt;div onmouseover=&quot;alert(1)&quot;&gt;');
  });

  test('二次转义是显式行为（esc(esc(x))），不产生裸标签', () => {
    const once = esc('<b>');
    const twice = esc(once);
    expect(twice).toBe('&amp;lt;b&amp;gt;');
    assertInert(twice);
  });
});

describe('esc() — 前端 7 页面源码契约', () => {
  const htmlFiles = [
    'dashboard.html', 'floor.html', 'sessions.html', 'logs.html',
    'knowledge.html', 'proxy-config.html', 'skills.html',
  ];

  test.each(htmlFiles)('%s 的 esc() 仍含完整转义策略', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
    // 抽取 function esc(...) { ... } 函数体（非贪婪到配平的第一个右括号不太可靠，
    // 这里取函数头之后 600 字符窗口，覆盖两种已知实现的全部特征行）
    const m = src.match(/function\s+esc\s*\([^)]*\)\s*\{/);
    expect(m).not.toBeNull();
    const body = src.slice(m.index, m.index + 600);
    const isDomStrategy = body.includes('textContent') && body.includes('innerHTML');
    const isRegexStrategy = /&amp;/.test(body) && /&lt;/.test(body) && /&gt;/.test(body);
    expect(isDomStrategy || isRegexStrategy).toBe(true);
    // 两种策略都必须覆盖引号（DOM 式靠后续 replace 补；正则式靠字符类含 " '）
    if (isDomStrategy) {
      expect(body).toMatch(/replace\(\/["']\/g/);
    } else {
      expect(body).toMatch(/\[&<>"']/);
    }
  });

  // 审计备注（2026-10-14）：public/ 下其余页面已逐个人工审计——
  //   index.html 无 innerHTML；login.html 两处 innerHTML 一处为静态 SVG 切换、
  //   一处只插服务端下发的数字分钟数，均不注入用户可控字符串，故不强制要求 esc。
  //   新增页面若出现 innerHTML 注入动态内容，必须同步补 esc 并加入上方清单。
});
