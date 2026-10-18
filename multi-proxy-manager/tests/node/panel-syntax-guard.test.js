'use strict';

// 面板 script 语法横向守卫（2026-10-16 新增）
//
// 为什么要有这个测试：
//   proxy-config.html 曾因一行 `'</span>');</div>'`（把 ')'、';'、'</div>' 搅在
//   一起）导致**整个 <script> 块语法错误 → 浏览器拒绝执行整块 JS**。后果不是
//   「某个按钮不灵」，而是页面所有交互全部失效：加载 provider、切模型、启停
//   代理、测连通性，一个都不工作。静态 HTML 照常渲染，所以肉眼看不出来。
//
//   该错误自进仓库起就存在，之所以一直没被发现，是因为**没有任何测试覆盖
//   public/*.html 的 script 语法**——此前只有 dashboard / logs 两页有行为测试
//   （tests/node/panel-read-failure.test.js），proxy-config / knowledge / skills
//   从未被执行过。
//
//   同期教训：上一轮删 logs.html 的 generateMockLogs 死代码时误删了 renderLogLine
//   定义，也是「改动引入的回归没有守卫」。这类回归的共同特征是——文件看着
//   正常，直到有人真的打开页面。
//
// 所以这里做横向守卫：**每个 public/*.html 的每个 <script> 块都必须能被
// new Function 解析**。新增页面自动纳入，无需维护清单。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// type= 的 script（如 application/json、application/ld+json）不是 JS，跳过。
function extractJsBlocks(html) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\btype\s*=/.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

// 剥掉「整行注释」再查 mock 残留——否则 2026-10-16 写进代码里的历史说明
// （「过去 getMockStatus() 在 /api/status 失败时喂三个假代理…」）会被当成
// 真调用误报。注释是文档，必须留；要查的是代码。
//
// 为什么用逐行而不是状态机：第一版写了完整的字符串/模板/注释状态机，结果被
// esc() 里的正则字面量击穿——`.replace(/"/g,'&quot;').replace(/'/g,'&#39;')`
// 中正则内的引号被当成字符串定界符，状态一路错到几百行外。要正确处理正则
// 字面量得先分辨「除号」和「正则开始」，那需要完整的 tokenizer，为一个
// 守卫测试引入它不划算。
//
// 口径与约定：只剥**整行**注释（行 trimmed 后以 // 或 /* 开头）。
// ⚠️ 因此立一条规矩：**在代码里写涉及 mock 字样的历史说明时，必须单独起行写**，
// 不要写成行尾注释（`x = 1; // 曾是 getMockStatus()`）——行尾注释剥不掉，
// 会让这个守卫误报，然后大家就会开始忽略它。
function stripWholeLineComments(blocks) {
  const kept = [];
  let inBlock = false;
  for (const code of blocks) {
    for (const raw of code.split('\n')) {
      const line = raw.trim();
      if (inBlock) {
        if (line.indexOf('*/') !== -1) inBlock = false;
        continue;
      }
      if (line.indexOf('//') === 0) continue;
      if (line.indexOf('/*') === 0) {
        if (line.indexOf('*/') === -1) inBlock = true;
        continue;
      }
      kept.push(raw);
    }
  }
  return kept.join('\n');
}

function listPages() {
  return fs.readdirSync(PUBLIC)
    .filter(f => f.endsWith('.html'))
    .sort();
}

test('横向守卫：public/ 下每个 .html 的每个 <script> 块都必须可解析', () => {
  const pages = listPages();
  if (pages.length === 0) throw new Error('public/ 下没有 .html，守卫跑空了');

  const failures = [];
  let checkedBlocks = 0;

  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const blocks = extractJsBlocks(html);
    if (blocks.length === 0) {
      failures.push(page + '：没有 <script> 块（是静态页还是漏了？）');
      continue;
    }
    blocks.forEach((code, i) => {
      checkedBlocks++;
      try {
        // 只解析不执行——执行需要 DOM，那是由 panel-read-failure.test.js 负责的。
        new Function(code);
      } catch (e) {
        failures.push(page + ' 第 ' + (i + 1) + ' 个 script 块语法错误: ' + e.message);
      }
    });
  }

  if (failures.length > 0) {
    throw new Error(
      '有 ' + failures.length + ' 个页面 script 块无法解析（浏览器会拒绝执行整块 JS，\n' +
      '页面所有交互静默失效，静态 HTML 照常渲染所以肉眼看不出来）：\n  ' +
      failures.join('\n  ')
    );
  }
});

test('横向守卫：public/ 下不允许残留 mock 假数据兜底', () => {
  // 2026-10-16 面板走查的结论：读失败时喂假数据比报错更糟。
  //   - dashboard getMockStatus：/api/status 失败 → 三个假代理（pid 12345 / uptime「2h34m」）
  //   - dashboard getMockVersion：假版本 '1.0.3'（版本号是「要不要升级」的判断依据）
  //   - logs.html generateMockLogs：20+ 条不存在日志，含假 ERROR
  //     'Upstream connection refused: codex-api service unavailable'
  //   - proxy-config MOCK_PROVIDERS：4 个假 provider 带 sk-test-key-xxxxx 假 key
  // 三处已删干净。这里守住，防止有人「为了演示效果」再加回来。
  //
  // ⚠️ 判定口径：只查**函数定义与调用**，不查注释里的历史说明
  //    （logs.html 注释里保留着 generateMockLogs 的来历，那是文档不是代码）。
  const pages = listPages();
  const banned = [
    /function\s+getMockStatus\b/,
    /function\s+getMockVersion\b/,
    /function\s+generateMockLogs\b/,
    /getMockStatus\s*\(\s*\)/,
    /getMockVersion\s*\(\s*\)/,
    /generateMockLogs\s*\(\s*\)/
  ];
  const hits = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    // 先剥注释再查——注释里的历史说明不是代码。
    const code = stripWholeLineComments(extractJsBlocks(html));
    for (const re of banned) {
      const m = code.match(re);
      if (m) hits.push(page + '：命中 ' + m[0]);
    }
  }
  if (hits.length > 0) {
    throw new Error('mock 假数据兜底又回来了：\n  ' + hits.join('\n  '));
  }
});
