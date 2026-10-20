// @ts-nocheck
/* eslint-disable */
/**
 * legal.test.js — D1「法务文本可达」纯逻辑 + 渲染 + 路由接线断言（对应 2026-10-19 评审
 * §3-P2#6「数据/隐私承诺与代码不一致」、§6-P1#1「勾选同意→法务面板不可见」、§6-P3#9
 * 「首启页承诺与法务条款一致性」）。
 *
 * 修复点：法务文本做成面板内可达——新增 lib/legal.js（纯读取 + 服务端安全渲染）+ /api/legal 路由
 * + public/legal.html + consent.html 脚注 / settings 关于 tab 的链接。
 *
 * 覆盖：
 *  1. 读真实 docs/legal 定稿文本（terms/privacy）→ ok / 版本 / html 非空
 *  2. 渲染无残留 ** 字面量（防渲染污染，与首启页同标准）、<strong> 配平、XSS 转义
 *  3. 未知 type / 目录缺失 → fallback，不抛、不断链（指向官网）
 *  4. 自定义 dir 注入式读 fixture（可单测，不依赖仓库路径）
 *  5. routeMap/consent.html/settings.html/legal.html 的「法务可达」接线存在
 *
 * 运行：npm test 自动纳入；node --experimental-vm-modules 下纯 require，无 server 启动副作用。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const legal = require('../../lib/legal');

const REPO = path.join(__dirname, '..', '..');      // multi-proxy-manager/
const PROJECT_ROOT = path.join(REPO, '..');         // multi-proxy/
const DOCS = path.join(PROJECT_ROOT, 'docs', 'legal');

describe('lib/legal.js — D1 法务可达', () => {
  test('读真实 docs/legal 定稿文本（terms/privacy）→ ok + 版本 + 非空 HTML', () => {
    const terms = legal.legalDoc('terms');
    expect(terms.ok).toBe(true);
    expect(terms.fallback).toBeFalsy();
    expect(terms.title).toBe('用户服务协议');
    expect(terms.version).toMatch(/^v\d+\./);
    expect((terms.html || '').length).toBeGreaterThan(500);
    const priv = legal.legalDoc('privacy');
    expect(priv.ok).toBe(true);
    expect(priv.title).toBe('隐私政策');
    expect((priv.html || '').length).toBeGreaterThan(500);
  });

  test('渲染无 ** 字面量残留（防渲染污染，与首启页同标准）+ <strong> 配平', () => {
    for (const t of ['terms', 'privacy']) {
      const html = legal.legalDoc(t).html || '';
      // 不检查整文件的 | 表格竖线（mdToHtml 渲染 <table> 合法），只查 ** 字面量残留
      expect(html).not.toMatch(/\*\*</);
      const open = (html.match(/<strong>/g) || []).length;
      const close = (html.match(/<\/strong>/g) || []).length;
      expect(open).toBe(close);
    }
  });

  test('XSS 转义：法务文本含 <img onerror> / <script> 被 esc，不产生可执行标签', () => {
    const out = legal.mdToHtml('a **<img src=x onerror=alert(1)> b** and <script>window.__pwned=1</script>');
    // 关键：真实可执行标签被转义；转义后的 <img/<script 文本仍可能以 &lt;img 形式出现属正常
    expect(out).not.toMatch(/<script>/i);
    expect(out).not.toMatch(/<img[^&]/i);        // 没有原始 <img（紧跟非 &）即未被转义才危险
    expect(out).toMatch(/&lt;script&gt;/);
  });

  test('未知 type → fallback（ok=false，不断链 + 列可用类型），不抛', () => {
    const r = legal.legalDoc('bogus');
    expect(r.ok).toBe(false);
    expect(r.fallback).toBe(true);
    expect(Array.isArray(r.available)).toBe(true);
    expect(r.online).toMatch(/sifking/);
  });

  test('目录缺失 → fallback（文件不在则不抛、不 500，指向官网）', () => {
    const r = legal.legalDoc('terms', { dir: path.join(os.tmpdir(), 'no-such-legal-dir-' + process.pid) });
    expect(r.ok).toBe(false);
    expect(r.fallback).toBe(true);
    expect(r.title).toBe('用户服务协议');
    expect(r.online).toMatch(/https/);
  });

  test('注入式：自定义 dir 读 fixture（不依赖仓库路径，确定性）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-fixture-'));
    fs.writeFileSync(path.join(dir, '用户服务协议.md'),
      '# 测试协议\n\n这是 **加粗** 的文本。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'utf8');
    fs.writeFileSync(path.join(dir, '隐私政策.md'),
      '# 测试隐私\n\nv2.3 草案。\n\n- 第1条\n- 第2条\n', 'utf8');
    const t = legal.legalDoc('terms', { dir });
    expect(t.ok).toBe(true);
    expect(t.html).toMatch(/<h1/);
    expect(t.html).toMatch(/<strong>加粗<\/strong>/);
    expect(t.html).toMatch(/<table/);
    const v = legal.legalDoc('privacy', { dir });
    expect(v.version).toBe('v2.3');
    expect(v.html).toMatch(/<li>第1条<\/li>/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('defaultDir 解析到仓库 docs/legal，且真实存在', () => {
    const d = legal.defaultDir({});
    expect(d).toMatch(/docs\/legal$/);
    expect(fs.existsSync(path.join(d, '用户服务协议.md'))).toBe(true);
  });
});

describe('接线 —— 法务可达入口存在', () => {
  const PUB = path.join(REPO, 'public');
  const readPub = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

  test('legal.html 存在且为自包含可达页（fetch /api/legal + 双 tab + 深链 ?tab=）', () => {
    const h = readPub('legal.html');
    expect(h).toMatch(/\/api\/legal/);
    expect(h).toMatch(/data-type="terms"/);
    expect(h).toMatch(/data-type="privacy"/);
    expect(h).toMatch(/URLSearchParams/);   // 支持 ?tab= 深链
    expect(h).not.toMatch(/\*\*/);           // 静态页 chrome 无 ** 字面量
  });

  test('consent.html 脚注含可达 /legal 链接（不再指向打不开的 docs 路径）', () => {
    const h = readPub('consent.html');
    expect(h).toMatch(/href="\/legal"/);
    // 旧的「随 v1.0 补齐」死承诺文案应已改为可达链接
    expect(h).toMatch(/打开法务页/);
  });

  test('settings.html 关于 tab 含法务入口 /legal', () => {
    const h = readPub('settings.html');
    expect(h).toMatch(/id="goLegal"/);
    expect(h).toMatch(/href="\/legal"/);
  });

  test('server.js routeMap 含 /legal，且 /api/legal 路由已挂载', () => {
    const s = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    expect(s).toMatch(/'\/legal':\s*'legal\.html'/);
    expect(s).toMatch(/app\.get\('\/api\/legal'/);
    expect(s).toMatch(/require\('\.\/lib\/legal'\)/);
  });
});
