// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

  // 2026-10-02 真付费上游实测（64 号 §七坑 6）：Anthropic 线上助手消息 content 可能是
  // [{thinking:'…'},{text:'ok'}]，且 **thinking 能把 max_tokens 吃满**（max_tokens=16 时
  // 整条响应没有 text 块；Kimi 一例 output=27 里 23 是 thinking）。
  // 于是按「只认 text」的口径：thinking 判不出超长 ⇒ 压不掉；就算压了 text，
  // 账本也只减 text 那部分 —— 又是一次静默少算。所以必须**按块类型分账**。
  test('Anthropic thinking 块：必须被压缩、结论原样保住、账本算全', () => {
    require(MEM).params.maxMsgChars = 40;
    const hist = [{
      type: 'message', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'T:' + 't'.repeat(300) },
        { type: 'text', text: 'ok' },
      ],
    }];
    const r = run('onHistory', { history: hist });
    const c = r.out.history[0].content;
    expect(c).toHaveLength(2);              // 压缩内容，不切条/不删 part
    expect(c[0].type).toBe('thinking');     // 写回保住 part 类型，别把请求体换成另一种协议
    expect(c[0].thinking.length).toBeLessThan(300);
    expect(c[1].type).toBe('text');
    expect(c[1].text).toBe('ok');           // 结论（text）原样保留，不能跟着 thinking 一起被砍
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

  test('foldToolOutput：认 responses 协议的 function_call_output（codex 主力形态）', () => {
    require(MEM).params.foldToolOutput = true;
    const hist = [
      { type: 'function_call', call_id: 'c9', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c9', output: 'y'.repeat(8000) },
    ];
    const r = run('onHistory', { history: hist });
    const out = r.out.history[1];
    // 该折的折掉：真省了 token
    expect(r.netTokenDelta).toBeLessThan(0);
    // 折了不能把协议换了：type 与 call_id 必须原样留着
    expect(out.type).toBe('function_call_output');
    expect(out.call_id).toBe('c9');
    expect(out.output).toContain('已折叠');
    expect(r.out.history).toHaveLength(2); // 不改条数
  });

  test('foldToolOutput：output 是 part 数组时保留 part 的 type', () => {
    require(MEM).params.foldToolOutput = true;
    const hist = [
      { type: 'function_call_output', call_id: 'c2', output: [{ type: 'output_text', text: 'z'.repeat(5000) }] },
    ];
    const r = run('onHistory', { history: hist });
    const parts = r.out.history[0].output;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('output_text'); // 不是被改写成 text
    expect(parts[0].text).toContain('已折叠');
    expect(r.netTokenDelta).toBeLessThan(0);
  });

  test('foldToolOutput：output 无文本 part 时不硬塞一个 type 进去', () => {
    require(MEM).params.foldToolOutput = true;
    const hist = [{ type: 'function_call_output', call_id: 'c3', output: [{ type: 'input_image', image: 'x' }] }];
    const r = run('onHistory', { history: hist });
    expect(r.out.history[0].output).toEqual([{ type: 'input_image', image: 'x' }]);
    expect(r.netTokenDelta).toBeNull(); // 没省，就不报节省
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

describe('工具调用证据：responses 协议的顶层调用条目必须被认到', () => {
  // 成因：codex 走 wire_api=responses，工具调用写在 input[] 的**顶层**
  // （{ type:'function_call', name }），不带 content 数组。此前 activeToolNames
  // 只扫 tool_calls 与 content[]，usedNames 恒空 → handler 永远
  // fallback('no-usage-evidence') → 重写模式在 codex 主链路上一次都不触发，
  // 而「跑了但没省」和「压根没算过」在日志上长得一模一样。
  const LAZY = require(path + 'packs/curator/policies/tools-lazyload.js');
  // ⚠️ 至少 5 把：handler 先判 minTools（默认 4），3 把会被 below-min-tools 提前挡掉，
  //    根本走不到「有没有调用证据」这一支——fixture 数写少了测的不是想测的东西。
  const tools = [
    { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'write_stdin', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'update_goal', parameters: { type: 'object', properties: {} } },
  ];
  const withCall = (extra) => ({
    agentType: 'coding',
    api: 'responses',
    messages: [
      { type: 'function_call', id: 'fc1', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', id: 'fc1', output: 'ok' },
    ].concat(extra || []),
    tools,
    history: [],
  });

  test('顶层 function_call 条目能被认成「用过」的证据', () => {
    // ⚠️ 不断言具体 prune 模式：模式由自测的 k 决定（k=0 → mid），
    //    断言模式等于把「k 估得准不准」混进这条用例；这里只钉「证据被认到、确实裁了」。
    const r = LAZY.handler(withCall([{ type: 'message', role: 'user', content: 'x' }]), {});
    expect(r.reason).toMatch(/^lazy-loaded/);
    expect(r.kept).toBeLessThan(tools.length);
    expect(r.activeTools).toEqual(['exec_command']);
  });

  test('没有调用证据时（首轮）依然不裁，避免模型先不知道能力全集', () => {
    const r = LAZY.handler({ agentType: 'coding', api: 'responses', messages: [{ type: 'message', role: 'user', content: 'x' }], tools, history: [] }, {});
    expect(r.reason).toBe('no-usage-evidence');
    expect(r.kept).toBe(tools.length);
  });

  test('mcp_tool_call 走同一条证据通道', () => {
    const r = LAZY.handler({
      agentType: 'coding', api: 'responses', tools,
      messages: [{ type: 'mcp_tool_call', id: 'mc1', name: 'update_goal', arguments: '{}' }, { type: 'message', role: 'user', content: 'x' }],
      history: [],
    }, {});
    expect(r.reason).toMatch(/^lazy-loaded/);
    expect(r.activeTools).toEqual(['update_goal']);
  });

  test('回应本体的 function_call_output 不当作调用证据（只有名字才算）', () => {
    const r = LAZY.handler({
      agentType: 'coding', api: 'responses', tools,
      messages: [{ type: 'function_call_output', id: 'fc1', output: 'ok' }, { type: 'message', role: 'user', content: 'x' }],
      history: [],
    }, {});
    expect(r.reason).toBe('no-usage-evidence');
  });
});
