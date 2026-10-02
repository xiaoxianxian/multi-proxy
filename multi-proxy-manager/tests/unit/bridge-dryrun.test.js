'use strict';

// bridge-dryrun · 影响面报告（回应 OpenShell policy prover 的同构问题）
//
// 桥的 rewrite 模式会把 policy 输出写回真实请求体。在没人能回答「开了会改什么」之前，
// 那个开关不敢开。本文件锁住三件事：
//   ① 「命中」的判据是请求体真的变了，不是 policy 说它改了
//   ② pack 默认全关时影响面恒为空
//   ③ params 用完即还原，防止同进程多组对照互相污染

const path = '../../../';
const D = require(path + 'tools/bridge-dryrun.js');

const CHAT = {
  body: {
    model: 'demo',
    messages: [
      { role: 'system', content: 'you are a coding agent' },
      { role: 'user', content: 'read it' },
      { role: 'tool', name: 'Read', content: 'x'.repeat(4000) },
      { role: 'user', content: '结论' },
    ],
  },
  api: 'chat-completions',
};

// codex responses 真包形状：content 是 [{type:'input_text'}] 内容块
const RESP = {
  body: {
    model: 'demo',
    instructions: 'you are a coding agent',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(4000) }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] },
    ],
  },
  api: 'responses',
};

// 纯图片条目：history 里一个文本 part 都没有 → 压缩器不硬塞 type，写了回却零变化。
// 「假节省」detector 的活靶子（此前用 responses 内容块当靶子，那是旧 textOf 静默失效的产物）
const IMAGE = {
  body: {
    model: 'demo',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这张图里是什么' }] },
    ],
  },
  api: 'responses',
};

describe('bridge-dryrun', () => {
  test('parseArgs 拒绝不合规的 --change', () => {
    expect(() => D.parseArgs(['--corpus', 'x', '--change', 'bad'])).toThrow(/hook:param=value/);
  });

  test('diffFields 区分新增与修改', () => {
    const c = D.diffFields({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(c.map((x) => x.field).sort()).toEqual(['b', 'c']);
    expect(c.find((x) => x.field === 'c').beforeChars).toBe(0);
  });

  test('默认全关：命中 0 且 token 零变化', () => {
    const r = D.runOne(CHAT, []);
    expect(r.hit).toBe(false);
    expect(r.after.total).toBe(r.before.total);
    expect(r.changed).toHaveLength(0);
  });

  test('折叠 tool 输出：messages 字段字节下降，条数不变', () => {
    const r = D.runOne(CHAT, [{ hook: 'onHistory', change: 'foldToolOutput', value: true }]);
    expect(r.hit).toBe(true);
    expect(r.changed.map((x) => x.field)).toContain('messages');
    expect(r.changed.find((x) => x.field === 'messages').deltaChars).toBeLessThan(0);
    expect(r.after.msgs).toBe(r.before.msgs);
    expect(r.after.total).toBeLessThan(r.before.total);
  });

  test('responses 的 input_text 块现在真会命中（旧 textOf 只认 text 时这里是零变化）', () => {
    const r = D.runOne(RESP, [{ hook: 'onHistory', change: 'maxMsgChars', value: 800 }]);
    expect(r.hit).toBe(true);
    expect(r.after.total).toBeLessThan(r.before.total);
  });

  test('🔴 policy 写回但请求体零变化 → 判未命中，并记 writtenFields', () => {
    // 靶子换成纯图片条目：没有任何文本 part，压缩器「不硬塞一个 type 进去」，
    // 于是 policy 写了回、字节却一字节没动。
    const r = D.runOne(IMAGE, [{ hook: 'onHistory', change: 'maxMsgChars', value: 800 }]);
    expect(r.changed).toHaveLength(0);
    expect(r.hit).toBe(false);
    expect(r.writtenFields.length).toBeGreaterThan(0);
  });

  test('params 用完还原，不污染同进程后续对照', () => {
    const mod = require(path + 'packs/curator/policies/memory-history.js');
    const before = JSON.parse(JSON.stringify(mod.params));
    D.runOne(CHAT, [{ hook: 'onHistory', change: 'foldToolOutput', value: true }]);
    expect(mod.params).toEqual(before);
  });
});
