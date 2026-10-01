'use strict';

// Curator pack · 真会改写内容的 handler（此前 5 个 policy 全是 passthrough，
// 即便开 rewrite 节省也 ≈ 0）
//
// 三条纪律（接手 agent 别破）：
//   ① 默认全关 = passthrough，零行为变更（非侵入铁律④）
//   ② 没产生变化报 null 不报 0——0 会被读成「跑了但确实没省」
//   ③ delta 一律走 ledger 同一把秤，policy 不自报无实测依据的数字
//
// ⚠️ params 是模块级共享（require cache），每个用例前必须重置，否则互相污染。

const path = '../../../';
const { createCurator, CHANGE_VALIDATORS } = require(path + 'packs/curator/curator-engine.js');
const { fold } = require(path + 'l2/context-fold.js');
const { measureText } = require(path + 'packs/curator/ledger.js');

function expectTokens(text) {
  return fold({ messages: [{ role: 'user', content: text }] }).estimate.total;
}

const MEM = path + 'packs/curator/policies/memory-history.js';
const CAP = path + 'packs/curator/policies/capability-tool.js';
const ACT = path + 'packs/curator/policies/action-response.js';

function resetParams() {
  const m = require(MEM).params;
  m.keepLastN = null;
  m.maxMsgChars = null;
  m.foldToolOutput = false;
  const c = require(CAP).params;
  c.maxOutputChars = null;
  c.headChars = null;
  c.tailChars = null;
  require(ACT).params.simplify = 'pass';
}

beforeEach(resetParams);
afterEach(resetParams);

function run(hook, ctx) {
  const c = createCurator();
  c.enable();
  return c.apply(hook, Object.assign({ agentType: 'coding' }, ctx)).results[0];
}

describe('Memory 面 · 内容级压缩（改内容，不改条数）', () => {
  const long = (n, tag) => ({ role: 'user', content: `${tag}:${'x'.repeat(n)}` });

  test('默认全关：原样透传，报 null', () => {
    const hist = [long(50, 'a'), long(50, 'b')];
    const r = run('onHistory', { history: hist });
    expect(r.out.history).toEqual(hist);
    expect(r.netTokenDelta).toBeNull();
  });

  test('maxMsgChars：内容被压缩但**条数不变**', () => {
    require(MEM).params.maxMsgChars = 40;
    const hist = [long(300, 'a'), long(300, 'b'), long(300, 'c')];
    const r = run('onHistory', { history: hist });
    expect(r.out.history).toHaveLength(3); // 关键：不是切条数
    expect(r.out.history[0].content.length).toBeLessThan(300);
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  // 50 号文档实测：codex 走 /v1/responses，文本 part 叫 **input_text**（助手侧叫 output_text），
  // 只有 chat 协议才叫 'text'。只认 'text' 的后果是「filter 出空数组 → join 出空串 → 长度 0
  // → 判定没超长 → 压缩静默恒等于零且零报错」，本机真实语料 18/18 条全部命中不到。
  // 这类「静默失效」比崩掉更难发现，所以钉死在测试里，别让后人改回去。
  test('codex/responses 的 input_text：必须被压缩（认死 text 会静默恒等于零）', () => {
    require(MEM).params.maxMsgChars = 40;
    const hist = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'a:' + 'x'.repeat(300) }] }];
    const r = run('onHistory', { history: hist });
    expect(r.out.history[0].content[0].type).toBe('input_text'); // 写回必须保住 part 类型，改成 chat 的 text 等于换协议
    expect(r.out.history[0].content[0].text.length).toBeLessThan(300);
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('助手侧 output_text 同样认（不是 output_text 就漏掉一半历史）', () => {
    require(MEM).params.maxMsgChars = 40;
    const hist = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b:' + 'y'.repeat(300) }] }];
    const r = run('onHistory', { history: hist });
    expect(r.out.history[0].content[0].type).toBe('output_text');
    expect(r.out.history[0].content[0].text.length).toBeLessThan(300);
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('纯图片消息：不硬塞一个 text part 进请求体（宁可这条不压，也不能注入脏 type）', () => {
    require(MEM).params.maxMsgChars = 40;
    const hist = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }] }];
    const r = run('onHistory', { history: hist });
    expect(r.out.history[0].content).toHaveLength(1);
    expect(r.out.history[0].content[0].type).toBe('input_image');
    expect(r.netTokenDelta).toBeNull();
  });

  test('头尾保留：尾部内容还在（只留头部会丢掉错误堆栈/最新日志）', () => {
    require(MEM).params.maxMsgChars = 40;
    const tail = 'TAIL-MARK';
    const hist = [{ role: 'user', content: `${'x'.repeat(300)}${tail}` }];
    const r = run('onHistory', { history: hist });
    expect(r.out.history[0].content).toContain(tail);
    expect(r.out.history[0].content).toContain('已省略');
  });

  test('foldToolOutput：只折叠 role=tool，其他 role 不动', () => {
    require(MEM).params.foldToolOutput = true;
    const hist = [
      { role: 'user', content: '提问内容' },
      { role: 'tool', content: 'y'.repeat(500), name: 'grep' },
      { role: 'assistant', content: '回答内容' },
    ];
    const r = run('onHistory', { history: hist });
    expect(r.out.history).toHaveLength(3);
    expect(r.out.history[0].content).toBe('提问内容');
    expect(r.out.history[1].content).toContain('已折叠');
    expect(r.out.history[1].content).toContain('grep');
    expect(r.out.history[2].content).toBe('回答内容');
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('压缩量是实测差额，不是拍脑袋的自报数', () => {
    require(MEM).params.maxMsgChars = 40;
    const before = 'z'.repeat(300);
    const hist = [{ role: 'user', content: before }];
    const r = run('onHistory', { history: hist });
    const after = r.out.history[0].content;
    expect(r.netTokenDelta).toBe(-(measureText(before) - measureText(after)));
  });

  test('keepLastN + maxMsgChars 叠加：省的是「丢弃 + 压缩」两部分', () => {
    const m = require(MEM).params;
    m.keepLastN = 2;
    m.maxMsgChars = 40;
    const hist = [long(300, 'a'), long(300, 'b'), long(300, 'c'), long(300, 'd')];
    const r = run('onHistory', { history: hist });
    expect(r.out.history).toHaveLength(2);
    const droppedOnly = (() => {
      const m2 = require(MEM).params;
      m2.maxMsgChars = null;
      return run('onHistory', { history: hist }).netTokenDelta;
    })();
    expect(r.netTokenDelta).toBeLessThan(droppedOnly); // 压缩让省得更多
  });

  test('非消息对象（如数字）原样透传，不崩', () => {
    require(MEM).params.maxMsgChars = 40;
    const r = run('onHistory', { history: [1, 2, 3] });
    expect(r.out.history).toEqual([1, 2, 3]);
  });
});

describe('Capability 面 · 工具输出头尾保留', () => {
  test('默认全关：原样透传，报 null', () => {
    const r = run('onToolOutput', { rawOutput: 'x'.repeat(500), toolName: 'grep' });
    expect(r.out.rawOutput).toBe('x'.repeat(500));
    expect(r.netTokenDelta).toBeNull();
  });

  test('既有语义不变：maxOutputChars 硬截断，长度精确等于 N', () => {
    require(CAP).params.maxOutputChars = 100;
    const r = run('onToolOutput', { rawOutput: 'x'.repeat(1000), toolName: 'grep' });
    expect(r.out.rawOutput.length).toBe(100);
    expect(r.netTokenDelta).toBe(-expectTokens('x'.repeat(900)));
  });

  test('头尾模式：尾部的关键信息保留下来了', () => {
    const p = require(CAP).params;
    p.headChars = 60;
    p.tailChars = 40;
    const raw = `${'x'.repeat(500)}ERROR-at-the-end`;
    const r = run('onToolOutput', { rawOutput: raw, toolName: 'grep' });
    expect(r.out.rawOutput).toContain('ERROR-at-the-end');
    expect(r.out.rawOutput.length).toBeLessThan(raw.length);
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('输出没超预算时不改动、报 null', () => {
    const p = require(CAP).params;
    p.headChars = 600;
    p.tailChars = 400;
    const r = run('onToolOutput', { rawOutput: 'short output', toolName: 't' });
    expect(r.out.rawOutput).toBe('short output');
    expect(r.netTokenDelta).toBeNull();
  });
});

describe('Action 面 · 响应空白归一化', () => {
  test('pass（默认）不改响应、报 null', () => {
    const r = run('onResponse', { response: 'a\n\n\n\nb   ' });
    expect(r.out.response).toBe('a\n\n\n\nb   ');
    expect(r.netTokenDelta).toBeNull();
  });

  test('whitespace：压空行 + 去行尾空白，但不动词句', () => {
    require(ACT).params.simplify = 'whitespace';
    const r = run('onResponse', { response: '第一段   \n\n\n\n\n第二段' });
    expect(r.out.response).toBe('第一段\n\n第二段');
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('无冗余可压时报 null，不报 0', () => {
    require(ACT).params.simplify = 'whitespace';
    const r = run('onResponse', { response: '简洁文本' });
    expect(r.out.response).toBe('简洁文本');
    expect(r.netTokenDelta).toBeNull();
  });
});

describe('受限变更通道：新参数必须能被校验、非法值必须被拒', () => {
  test('合法值能安装', () => {
    const c = createCurator();
    expect(c.applyChange('onHistory', 'maxMsgChars', 500).installed).toBe(true);
    expect(c.applyChange('onHistory', 'foldToolOutput', true).installed).toBe(true);
    expect(c.applyChange('onToolOutput', 'headChars', 200).installed).toBe(true);
    expect(c.applyChange('onToolOutput', 'tailChars', 100).installed).toBe(true);
    expect(c.applyChange('onResponse', 'simplify', 'whitespace').installed).toBe(true);
  });

  test('非法值被拒（越界 / 类型错 / 枚举外）', () => {
    const c = createCurator();
    expect(c.applyChange('onHistory', 'maxMsgChars', 0).installed).toBe(false);
    expect(c.applyChange('onHistory', 'maxMsgChars', 99999).installed).toBe(false);
    expect(c.applyChange('onHistory', 'foldToolOutput', 'yes').installed).toBe(false);
    expect(c.applyChange('onResponse', 'simplify', 'aggressive').installed).toBe(false);
  });

  test('校验器覆盖了新增参数（否则只能绕过通道直接改 params）', () => {
    for (const k of ['maxMsgChars', 'foldToolOutput', 'headChars', 'tailChars', 'simplify']) {
      expect(typeof CHANGE_VALIDATORS[k]).toBe('function');
    }
  });
});
