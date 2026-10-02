'use strict';
// tools-lazyload 的闸门判据单测（coreTools 白名单是新增分支，得钉死）
//
// 背景：真流量 24 轮只裁了 1 轮，根因是 maxHide=floor(15×0.85)=12 在
// 「15 把工具只用过 1–2 把」这种最常见形态下必然拦截（想藏 14 把）。
// coreTools 的用途不是「多救几把工具」，而是把可藏基数从「未使用数」改成
// 「未使用数 − |core|」，让判据不再被「这轮恰好只调了 1 把」卡死。

const LAZY = require('../../../packs/curator/policies/tools-lazyload.js');

const NAMES = ['tool_00', 'tool_01', 'tool_02', 'tool_03', 'tool_04'];
const TOOLS = NAMES.map((n) => ({
  type: 'function',
  function: { name: n, description: '工具：' + n + ' 的项目资源处理与检索详细描述。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
}));
const used = (names) => [
  { role: 'assistant', content: null,
    tool_calls: names.map((n, i) => ({ id: 'c' + i, type: 'function', function: { name: n, arguments: '{}' } })) },
  ...names.map((n, i) => ({ role: 'tool', tool_call_id: 'c' + i, content: '{}' })),
];
const run = (names, budget) => LAZY.handler(
  { tools: TOOLS, messages: used(names), agentType: 'coding' }, { budget });

// 真实工具表（形状/名字照抄 logs/bridge-corpus-2026-10-02.jsonl 首轮请求体 13 项，
// 长度按真值缩到同量级：整表 3,689 tok = description 1,184 / parameters 1,905 / 外壳 605）。
// 🔴 必须混进非 function 条目：codex 0.159.3 发的不是清一色 function ——
//   apply_patch 是 { type:'custom', format:{ definition } }，另外还有
//   { type:'tool_search' }、{ type:'web_search' } 两项连 name 都没有。
//   只测清一色 function 的表，等于把真链路上最怪的那 3 项屏蔽掉了。
const REAL = [
  { type: 'function', name: 'exec_command', description: 'Runs a command in a PTY.', strict: false,
    parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'Shell command.' }, mode: { type: 'string' } }, required: ['cmd'] } },
  { type: 'function', name: 'write_stdin', description: 'Write stdin to a session.', strict: false,
    parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } },
  { type: 'function', name: 'list_mcp_resources', description: 'List MCP resources.', strict: false,
    parameters: { type: 'object', properties: { server: { type: 'string' } } } },
  { type: 'function', name: 'list_mcp_resource_templates', description: 'List MCP templates.', strict: false,
    parameters: { type: 'object', properties: { server: { type: 'string' } } } },
  { type: 'function', name: 'read_mcp_resource', description: 'Read an MCP resource.', strict: false,
    parameters: { type: 'object', properties: { uri: { type: 'string' } } } },
  { type: 'function', name: 'request_user_input', description: 'Ask the user for input.', strict: false,
    parameters: { type: 'object', properties: { question: { type: 'string' } } } },
  { type: 'custom', name: 'apply_patch', description: 'Edit files via freeform patch.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } },
  { type: 'function', name: 'view_image', description: 'View an image.', strict: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'function', name: 'get_goal', description: 'Get goal.', strict: false, parameters: { type: 'object' } },
  { type: 'function', name: 'create_goal', description: 'Create a goal.', strict: false,
    parameters: { type: 'object', properties: { title: { type: 'string' } } } },
  { type: 'function', name: 'update_goal', description: 'Update a goal with status and progress.', strict: false,
    parameters: { type: 'object', properties: { goal_id: { type: 'string' }, status: { type: 'string' } } } },
  { type: 'tool_search', execution: 'client', description: '# Tool discovery', parameters: { type: 'object' } },
  { type: 'web_search', external_web_access: false, search_content_types: ['text', 'image'] },
];
const realUsed = (names) => [
  { role: 'assistant', content: null,
    tool_calls: names.map((n, i) => ({ id: 'r' + i, type: 'function', function: { name: n, arguments: '{}' } })) },
  ...names.map((n, i) => ({ role: 'tool', tool_call_id: 'r' + i, content: 'ok' })),
];
// ⚠️ handler 的第二个参数是 io，配置要从 io.budget 里取（token-policy 自造的 budget
//    会盖外部字段，早年踩过同类坑）；直接把配置当 io 传 = 静默全用默认值。
const runReal = (names, cfg) => LAZY.handler(
  { tools: REAL, messages: realUsed(names), agentType: 'coding' }, { budget: cfg || {} });
const FORMS = [
  ['只跑过命令', ['exec_command']],
  ['命令+编辑', ['exec_command', 'apply_patch']],
  ['只编辑文件', ['apply_patch']],
];
const REQUIRED_CORE = ['exec_command', 'apply_patch', 'read_mcp_resource'];

// ⚠️ 下面所有用例都**显式钉 pruneMode**：auto 档会去读
//    ~/.multi-proxy/cache-estimate.json 里落盘的自测 k，同一个用例在标定前/标定后
//    会走到不同分支（实测踩到：同一条断言先绿后红，就是因为上一轮真流量把 k 落盘了）。
//    断言行为就必须钉死输入，不能让外部状态决定走哪条路。
describe('tools-lazyload · 真实工具表（13 项，含 custom/tool_search/web_search）', () => {
  const MID = { pruneMode: 'mid' };
  const SFX = { pruneMode: 'suffix' };
  // 显式传 coreTools 时要连 mode 一起给，否则只覆盖一个字段另一处走默认
  const cfg = (mode, core) => Object.assign({ pruneMode: mode }, core ? { coreTools: core } : {});

  test('默认 coreTools 已按真表填成三件套', () => {
    expect(REQUIRED_CORE).toEqual(['exec_command', 'apply_patch', 'read_mcp_resource']);
    // 且模块默认值的确是它（防止有人改了 DEFAULTS 而测试线还留在旧值）
    const r = runReal(['exec_command'], MID);
    expect(r.coreTools.slice().sort()).toEqual(REQUIRED_CORE.slice().sort());
  });

  test('空白名单时「只跑过命令」被闸门拦死；填三件套后放行（13−1=12 > maxHide=11 的真实成因）', () => {
    const without = runReal(['exec_command'], cfg('mid', []));
    expect(without.reason).toBe('would-over-hide');
    const withCore = runReal(['exec_command'], MID);
    expect(withCore.reason).toBe('lazy-loaded');
    expect(withCore.kept).toBeGreaterThanOrEqual(3);
  });

  test('被空白名单拦下的形态，填了默认 core 后全部放行', () => {
    const blocked = [];
    for (const [, used] of FORMS) {
      if (runReal(used, cfg('mid', [])).reason === 'would-over-hide') blocked.push(used);
    }
    expect(blocked.length).toBeGreaterThan(0); // 空白名单确实有形态被拦
    for (const used of blocked) {
      expect(runReal(used, MID).reason).not.toBe('would-over-hide');
    }
  });

  test('🔴 无 name 的 tool_search / web_search 会算进 total，但永不进保留集', () => {
    const r = runReal(['exec_command', 'apply_patch', 'read_mcp_resource'], MID);
    expect(r.total).toBe(13);
    expect(r.keptNames).not.toContain('tool_search');
    expect(r.keptNames).not.toContain('web_search');
  });

  test('suffix 在真表上不被 tail-used-blocked 打回（apply_patch 在中段第 7 位，不是末尾）', () => {
    const r = runReal(['exec_command', 'apply_patch'], cfg('suffix', []));
    expect(r.reason).toBe('lazy-loaded(suffix-only)');
    expect(r.kept).toBeGreaterThan(1);
  });
});

describe('tools-lazyload · coreTools 白名单', () => {
  test('默认 coreTools 为空：与加白名单前行为一致（5 把用过 1 把 → 想藏 4 > maxHide 4? 判据按现行式算）', () => {
    const r = run(['tool_00'], {}); // maxHide = floor(5×0.85) = 4，想藏 4 → 4 > 4 为假 ⇒ 放行
    expect(r.reason).toBe('lazy-loaded');
    expect(r.kept).toBe(1);
  });

  test('coreTools 与 used 重合时不重复计入保留集', () => {
    const a = run(['tool_00'], { coreTools: ['tool_00'] });
    expect(a.kept).toBe(1);
    expect(a.coreTools).toEqual(['tool_00']);
  });

  test('core 里有这轮没用过的：它必须被保留（kept ≥ core 数量）', () => {
    const r = run(['tool_00'], { coreTools: ['tool_00', 'tool_01', 'tool_02'] });
    expect(r.reason).toBe('lazy-loaded');
    expect(r.kept).toBe(3); // 用过的 1 把 + 白名单另外 2 把
    expect(r.coreTools).toEqual(['tool_00', 'tool_01', 'tool_02']);
  });

  test('🔴 白名单不参与 no-usage-evidence：首轮（无任何使用证据）必须全发', () => {
    const r = LAZY.handler(
      { tools: TOOLS, messages: [{ role: 'user', content: 'hi' }], agentType: 'coding' },
      { budget: { coreTools: ['tool_00', 'tool_01', 'tool_02'] } },
    );
    expect(r.reason).toBe('no-usage-evidence');
    expect(r.kept).toBe(5);
    expect(r.saved).toBe(0);
  });

  test('白名单把「用过 1 把」从被拦截救成放行（闸门基数变小的真实效果）', () => {
    const over = run(['tool_00'], { maxHideRatio: 0.85, coreTools: ['tool_00', 'tool_01'] });
    const without = run(['tool_00'], { maxHideRatio: 0.85 });
    // 15 把的真实形态：只调 1 把时，现状(maxHide=12)想藏 14 被拦；加了 2 把白名单后想藏 12 放行
    const N15 = Array.from({ length: 15 }, (_, i) => ({
      type: 'function',
      function: { name: 't' + i, description: '工具：t' + i + ' 的详细描述。',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    }));
    const mk15 = (names, budget) => LAZY.handler(
      { tools: N15, messages: used(names), agentType: 'coding' }, { budget });
    expect(mk15(['t0'], {}).reason).toBe('would-over-hide');             // 现状：拦
    expect(mk15(['t0'], { coreTools: ['t0', 't1', 't2'] }).reason).toBe('lazy-loaded'); // 白名单：放行
    expect(over.reason).toBe('lazy-loaded');
    expect(without.kept).toBe(1);
  });
});
