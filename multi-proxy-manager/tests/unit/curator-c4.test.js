'use strict';

// Curator pack · C4「pack 注入挂第七类」（28 号文档 §七.2）
//
// 验收：pack 开 / 关两态下第七类（skill）计数之差 == 注入净增量；关闭后归零。
// 语义纪律：注入是正成本、裁剪是负节省，两者分开记；没产生变化报 null 不报 0。
//
// ⚠️ policies/*.js 的 params 是模块级共享（require cache），每个用例前必须重置，
// 否则用例之间互相污染——上一轮的 15 个测试仍绿不代表本轮没被污染。

const path = '../../../';
const { createCurator, CHANGE_VALIDATORS } = require(path + 'packs/curator/curator-engine.js');
const { fold } = require(path + 'l2/context-fold.js');

// 独立参照口径：不经 ledger，直接用 context-fold 算期望值
function expectTokens(text) {
  return fold({ messages: [{ role: 'user', content: text }] }).estimate.total;
}
function expectMessagesTokens(msgs) {
  return fold({ messages: msgs }).estimate.total;
}

const REQ = { messages: [{ role: 'user', content: '写个快排' }] };
const PREFIX = '【上岗手册】先读仓库再动手，不要凭印象改代码。';

function resetParams() {
  require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = '';
  require(path + 'packs/curator/policies/memory-history.js').params.keepLastN = null;
  require(path + 'packs/curator/policies/capability-tool.js').params.maxOutputChars = null;
}

afterEach(resetParams);

describe('Curator pack · C4 注入挂第七类（skill 桶）', () => {
  test('pack 默认关：fold 的第七类为 0（非侵入铁律④ 零行为变更）', () => {
    const c = createCurator();
    expect(c.fold(REQ).estimate.byCategory.skill).toBe(0);
    expect(c.fold(REQ).bySource).toEqual({});
  });

  test('关态下即使 params 有 scenePrefix 也不注入（未启用 = 不产生开销）', () => {
    require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = PREFIX;
    const c = createCurator();
    expect(c.fold(REQ).estimate.byCategory.skill).toBe(0);
  });

  test('开态：第七类 == 注入文本 token 数，且 bySource 单列到 curator-pack', () => {
    require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = PREFIX;
    const c = createCurator();
    c.enable();
    const r = c.fold(REQ);
    const want = expectTokens(PREFIX);
    expect(want).toBeGreaterThan(0);
    expect(r.estimate.byCategory.skill).toBe(want);
    expect(r.bySource['curator-pack'].skill).toBe(want);
    // 注入必须只落在 skill 桶，不污染其他六类
    expect(r.estimate.byCategory.system).toBe(0);
    expect(r.estimate.byCategory.user).toBe(expectTokens('写个快排'));
  });

  test('开 / 关两态第七类之差 == 注入净增量；关闭后归零', () => {
    require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = PREFIX;
    const c = createCurator();
    const off = c.fold(REQ).estimate.byCategory.skill;
    c.enable();
    const on = c.fold(REQ).estimate.byCategory.skill;
    expect(on - off).toBe(expectTokens(PREFIX));
    c.disable();
    expect(c.fold(REQ).estimate.byCategory.skill).toBe(0);
  });

  test('scenePrefix 走受限变更通道（有校验：非字符串 / 超长被拦）', () => {
    expect(CHANGE_VALIDATORS.scenePrefix(PREFIX)).toBe(true);
    expect(CHANGE_VALIDATORS.scenePrefix(123)).toBe(false);
    expect(CHANGE_VALIDATORS.scenePrefix('x'.repeat(4001))).toBe(false);
  });
});

describe('Curator pack · C4 netTokenDelta 语义（注入正 / 裁剪负 / 无变化 null）', () => {
  test('注入上报正值（Prompt 面 = 成本，不是节省）', () => {
    require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = PREFIX;
    const c = createCurator();
    c.enable();
    const run = c.apply('onRequestAssemble', { agentType: 'coding', messages: [] });
    expect(run.results.length).toBe(1);
    expect(run.results[0].netTokenDelta).toBe(expectTokens(PREFIX));
    expect(run.results[0].netTokenDelta).toBeGreaterThan(0);
  });

  test('裁剪上报负值（Memory 面：裁掉的历史 = 节省）', () => {
    const history = [
      { role: 'user', content: '第一轮提问' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮提问' },
      { role: 'assistant', content: '第二轮回答' },
      { role: 'user', content: '第三轮提问' },
    ];
    require(path + 'packs/curator/policies/memory-history.js').params.keepLastN = 2;
    const c = createCurator();
    c.enable();
    const run = c.apply('onHistory', { agentType: 'coding', history });
    const want = expectMessagesTokens(history.slice(0, 3)); // 被裁掉的前 3 条
    expect(want).toBeGreaterThan(0);
    expect(run.results[0].netTokenDelta).toBe(-want);
    expect(run.results[0].out.history.length).toBe(2);
  });

  test('裁剪上报负值（Capability 面：截断的工具输出 = 节省）', () => {
    const raw = 'x'.repeat(1000);
    require(path + 'packs/curator/policies/capability-tool.js').params.maxOutputChars = 100;
    const c = createCurator();
    c.enable();
    const run = c.apply('onToolOutput', { agentType: 'coding', rawOutput: raw, toolName: 'grep' });
    expect(run.results[0].netTokenDelta).toBe(-expectTokens(raw.slice(100)));
    expect(run.results[0].out.rawOutput.length).toBe(100);
  });

  test('passthrough（参数未设）报 null 而不是 0 —— 0 会被读成「确实没省」', () => {
    const c = createCurator();
    c.enable();
    const mem = c.apply('onHistory', { agentType: 'coding', history: [{ role: 'user', content: 'hi' }] });
    const cap = c.apply('onToolOutput', { agentType: 'coding', rawOutput: 'short', toolName: 't' });
    const prm = c.apply('onRequestAssemble', { agentType: 'coding', messages: [] });
    expect(mem.results[0].netTokenDelta).toBeNull();
    expect(cap.results[0].netTokenDelta).toBeNull();
    expect(prm.results[0].netTokenDelta).toBeNull();
  });

  test('无 token 效应的两面（Planning / Action）恒为 null，不得虚报', () => {
    const c = createCurator();
    c.enable();
    const plan = c.apply('onRoute', { agentType: 'coding', taskMeta: {} });
    const act = c.apply('onResponse', { agentType: 'coding', response: 'ok' });
    expect(plan.results[0].netTokenDelta).toBeNull();
    expect(act.results[0].netTokenDelta).toBeNull();
  });

  test('注入与裁剪不被预先抵消：同一 run 里两个数各自可见', () => {
    // 这是 C4 的核心价值：净额会掩盖「注入花 40、压缩省 30」
    require(path + 'packs/curator/policies/prompt-assemble.js').params.scenePrefix = PREFIX;
    const injected = expectTokens(PREFIX);
    const c = createCurator();
    c.enable();
    const run = c.apply('onRequestAssemble', { agentType: 'coding', messages: [] });
    const skillFold = c.fold(REQ);
    expect(run.results[0].netTokenDelta).toBe(injected);        // 注入：正
    expect(skillFold.bySource['curator-pack'].skill).toBe(injected); // 第七类：单列
    expect(skillFold.estimate.byCategory.skill).toBe(injected);  // 没被别的桶吃掉
  });
});
