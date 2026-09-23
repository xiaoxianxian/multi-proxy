'use strict';
// P0 I1 RAG 知识库（拉模式）· 真跑验证 demo（node l2/knowledge-base/knowledge-base.demo.js）
// 全内存、零网络、零外部依赖。守 §8.6 验收纪律：数字/行为变动真跑取证，不靠模型自验。
// sync checks 用 check()；async checks 用 asyncChecks 串行 await（check() 不 await 返回的 promise）。
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { KnowledgeBase, chunk, cosine, toVec } = require('./knowledge-base.js');
const { Orchestrator } = require('../orchestrator.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS   ${name}`); }
  catch (e) { fail++; console.log(`FAIL   ${name}     -- ${e && e.message}`); }
};

// ---- 内核 ----
check('KB: 中文检索 round-trip（余弦相似度取最相关）', () => {
  const kb = new KnowledgeBase();
  kb.ingest({ id: 'd1', title: 'NO_PROXY 铁律', text: 'NO_PROXY 含裸逗号星号会致 ETIMEDOUT 绕过代理直连被墙 IP' });
  kb.ingest({ id: 'd2', title: 'Qwen 本地部署', text: 'Qwen3.8-27B 本地部署需 48GB 内存 与 Ollama 不并发' });
  const r = kb.retrieve({ query: '代理 绕过 网络 超时', topK: 2 });
  assert.strictEqual(r.length, 2, 'topK=2');
  assert.ok(r[0].id.startsWith('d1#'), `最相关应 d1, got ${r[0].id}`);
  assert.ok(r[0].score > 0, 'score>0');
});

check('KB: 空 query 不检索（拉模式：不自动注入）', () => {
  const kb = new KnowledgeBase();
  kb.ingest({ id: 'd1', title: 'x', text: 'hello' });
  assert.deepStrictEqual(kb.retrieve({ query: '   ', topK: 3 }), [], '空白 query 返回空');
});

check('KB: scope 过滤', () => {
  const kb = new KnowledgeBase();
  kb.ingest({ id: 'sh', title: '共享', text: '公共配置', scope: 'shared' });
  kb.ingest({ id: 'cx', title: 'codex', text: 'codex 私有', scope: 'codex' });
  assert.strictEqual(kb.retrieve({ query: '配置', scope: 'codex', topK: 5 }).length, 1, 'scope=codex');
  assert.strictEqual(kb.retrieve({ query: '配置', scope: 'shared' }).length, 1, 'scope=shared');
});

check('KB: 空库不抛 + status', () => {
  const kb = new KnowledgeBase();
  assert.deepStrictEqual(kb.retrieve({ query: 'anything' }), [], '空库空数组');
  const s = kb.status();
  assert.strictEqual(s.ready, true);
  assert.strictEqual(s.docs, 0);
});

check('KB: chunk 切块（段落 + 超长滑窗）', () => {
  const pieces = chunk('第一段\n\n第二段\n\n' + 'x'.repeat(2000), 800);
  assert.ok(pieces.length >= 3, `超长段滑窗切多块, got ${pieces.length}`);
});

check('KB: cosine 范围 [0,1]', () => {
  const a = toVec('hello world');
  const b = toVec('hello world foo');
  const s = cosine(a, b);
  assert.ok(s > 0 && s <= 1, `余弦在 (0,1], got ${s}`);
});

check('KB: dir 注入才落盘 + 重载恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const kb1 = new KnowledgeBase({ dir });
  kb1.ingest({ id: 'persisted', title: '铁律', text: 'NO_PROXY 绝不往全局 launchd 注入裸星号' });
  assert.ok(fs.existsSync(path.join(dir, 'knowledge.json')), '落盘 knowledge.json');
  const kb2 = new KnowledgeBase({ dir });
  const r = kb2.retrieve({ query: 'NO_PROXY 注入', topK: 1 });
  assert.strictEqual(r.length, 1, '重载可检索');
  assert.ok(r[0].id.startsWith('persisted'), '恢复文档');
  assert.strictEqual(kb2.status().persisted, true);
  assert.ok(dir.startsWith(os.tmpdir()), '落盘在 tmp 非 home');
});

check('KB: 非侵入（不写 ~/.codex 等 agent 文件）', () => {
  const codexDir = os.homedir() + '/.codex';
  const before = fs.existsSync(codexDir) ? fs.readdirSync(codexDir).length : 0;
  const kb = new KnowledgeBase(); // 仅内存
  kb.ingest({ id: 'x', title: 'x', text: 'y' });
  const after = fs.existsSync(codexDir) ? fs.readdirSync(codexDir).length : 0;
  assert.strictEqual(before, after, '~/.codex 条目数不变');
});

// ---- orchestrator 注入（async，串行 await）----
const asyncChecks = [
  { name: 'ORCH: retriever=null 时 ctx.knowledge undefined（不检索、不注入）', fn: async () => {
    const kb = new KnowledgeBase();
    kb.ingest({ id: 'd1', title: 't', text: 'some knowledge' });
    let sawKnowledge;
    const orch = new Orchestrator({ shadowMode: false, retriever: null,
      executor: async (st, ctx) => { sawKnowledge = ctx.knowledge; return { ok: true }; } });
    await orch.run({ input: 'do it', subtasks: [{ id: 't1', type: 'code', prompt: 'p', knowledgeQuery: 'q', deps: [] }], edges: [] });
    assert.strictEqual(sawKnowledge, undefined, 'retriever=null 不见 ctx.knowledge');
    } },
  { name: 'ORCH: retriever 注入 + useKnowledge → ctx.knowledge 挂检索结果', fn: async () => {
    const kb = new KnowledgeBase();
    kb.ingest({ id: 'spec', title: '项目规范', text: '测试用 ESM import jest 加 experimental-vm-modules tsc 不覆盖 tests' });
    let sawKnowledge = 'UNSET';
    const orch = new Orchestrator({ shadowMode: false, retriever: kb,
      executor: async (st, ctx) => { sawKnowledge = ctx.knowledge; return { ok: true }; } });
    await orch.run({ input: '写测试', subtasks: [{ id: 't1', type: 'code', prompt: 'jest', useKnowledge: true, knowledgeQuery: 'jest 测试 vm-modules 配置', deps: [] }], edges: [] });
    assert.ok(Array.isArray(sawKnowledge) && sawKnowledge.length >= 1, 'ctx.knowledge 数组非空');
    assert.strictEqual(sawKnowledge[0].title, '项目规范', '命中项目规范');
    } },
  { name: 'ORCH: shadowMode 下 retriever 注入也不检索（shadow 纪律）', fn: async () => {
    const kb = new KnowledgeBase();
    kb.ingest({ id: 'd1', title: 't', text: 'x' });
    let ranExecutor = false;
    const orch = new Orchestrator({ shadowMode: true, retriever: kb,
      executor: async () => { ranExecutor = true; } });
    await orch.run({ input: 'x', subtasks: [{ id: 't1', type: 'code', knowledgeQuery: 'q', useKnowledge: true, deps: [] }], edges: [] });
    assert.strictEqual(ranExecutor, false, 'shadow 下 executor 不被调用');
    } },
];

(async () => {
  console.log('=== P0 I1 RAG knowledge-base demo ===');
  for (const c of asyncChecks) {
    try { await c.fn(); pass++; console.log(`PASS   ${c.name}`); }
    catch (e) { fail++; console.log(`FAIL   ${c.name}     -- ${e && e.message}`); }
    }
  console.log(`\n结果：PASS=${pass}  FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})();
