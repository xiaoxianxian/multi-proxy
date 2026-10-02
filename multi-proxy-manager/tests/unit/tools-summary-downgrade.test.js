'use strict';
// tools-summary-downgrade（58 号方案 P3）单测
//
// 钉死三件事：
//   1. 默认 off —— 返回 null，桥的 MERGE_FIELDS 写不进 tools ⇒ 请求体一个字节不动；
//   2. 🔴 不删工具（P3 相对 lazyload 的全部价值就在这个「不变」上：工具数不塌、每轮输出不漂）；
//   3. 🔴 不碰硬契约：name / type / required / enum 取值 / format.definition ——
//      削掉 apply_patch 的 lark 定义一个字符就是上游报错，不是省一点钱。

const MOD = '../../../packs/curator/policies/tools-summary-downgrade.js';

// 🔴 真表（照抄 logs/bridge-corpus-2026-10-02.jsonl 首轮请求体 13 项，长度按真值缩到同量级：
//    整表 3,689 tok = description 1,184 / parameters 1,905 / 外壳 605）。
//    balanced 档「大头在 parameters」这条判据**只有在真表上才成立** ——
//    用清一色小 description 的合成表会把它测成假的（缩略表 parameters 占比被 description 冲淡）。
//    混进非 function 条目：apply_patch 是 { type:'custom', format:{ definition } }，
//    另两项 tool_search / web_search 连 name 都没有。
const REAL = [
  { type: 'function', name: 'exec_command', description:
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction. '
      + 'Use it to run shell commands such as git status, ls, or node -v.',
    strict: false,
    parameters: { type: 'object', properties: {
      cmd: { type: 'string', description: 'Shell command to execute.' },
      mode: { type: 'string', description: 'Session mode: either blocking or streaming.' },
    }, required: ['cmd'] } },
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
  { type: 'custom', name: 'apply_patch', description:
      'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, '
      + 'so do not wrap the patch in JSON.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } },
  { type: 'function', name: 'view_image', description: 'View an image.', strict: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'function', name: 'get_goal', description: 'Get goal.', strict: false, parameters: { type: 'object' } },
  { type: 'function', name: 'create_goal', description: 'Create a goal.', strict: false,
    parameters: { type: 'object', properties: { title: { type: 'string' } } } },
  { type: 'function', name: 'update_goal', description: 'Update a goal with status and progress.', strict: false,
    parameters: { type: 'object', properties: { goal_id: { type: 'string' }, status: { type: 'string' } } } },
  { type: 'tool_search', execution: 'client', description: '# Tool discovery\n\nSearches over deferred tool metadata.',
    parameters: { type: 'object' } },
  { type: 'web_search', external_web_access: false, search_content_types: ['text', 'image'] },
];

// 🔴 必须走 jest.isolateModules 冷加载，不能「先设 env → delete require.cache → require」。
//    实测踩到：后者在 Jest 下**不会**重新执行模块体，require 拿回的是上一次加载的旧实例，
//    于是同一个 mode 参数读到的是上一个 mode 的 DEFAULTS（断言报「mode=off 但 env=aggressive」——
//    症状看起来像 policy 的 bug，其实是测试的加载方式不对）。
//    mode 是在模块加载时从 env 读的，所以每个 mode 都必须换一个隔离注册表。
function load(mode) {
  const p = require.resolve(MOD);
  if (mode === undefined) delete process.env.CURATOR_SUMMARY_MODE;
  else process.env.CURATOR_SUMMARY_MODE = mode;
  let M;
  jest.isolateModules(() => { M = require(p); });
  return M;
}
const run = (M, mode) => M.handler({ tools: JSON.parse(JSON.stringify(REAL)), messages: [], agentType: 'coding' }, { budget: { mode } });
const fresh = (mode) => {
  const M = load(mode);
  return { M, r: run(M, mode) };
};

afterAll(() => { delete process.env.CURATOR_SUMMARY_MODE; });

describe('tools-summary-downgrade · 默认关（非侵入铁律）', () => {
  test('mode=off 时 handler 返回 null：桥写不进 tools 字段，请求体零改动', () => {
    const M = load(undefined);
    expect(M.DEFAULTS.mode).toBe('off');
    const r = run(M, 'off');
    expect(r).toBeNull();
  });

  test('未知 mode 也当 off 处理（别让拼错的字符串悄悄开始改写请求体）', () => {
    const M = load('Light'); // 大小写/拼错
    expect(run(M, 'Light')).toBeNull();
  });
});

describe('tools-summary-downgrade · 核心卖点：工具一个都不删', () => {
  test('light 与 aggressive 都保持 total 不变、tools 数组长度不变', () => {
    for (const mode of ['light', 'aggressive']) {
      const { r } = fresh(mode);
      expect(r).not.toBeNull();
      expect(r.tools.length).toBe(REAL.length);
      expect(r.total).toBe(REAL.length);
      expect(r.changed).toBeGreaterThan(0);
    }
  });

  test('🔴 冷契约字段一个字节都不许动：name/type/required/enum 取值/format.definition', () => {
    const { M, r } = fresh('aggressive');
    M.schemaTokens; // 口径函数存在性
    const before = JSON.parse(JSON.stringify(REAL));
    const after = r.tools;
    for (let i = 0; i < before.length; i++) {
      expect(after[i].name).toBe(before[i].name);
      expect(after[i].type).toBe(before[i].type);
    }
    expect(after[6].format).toEqual(before[6].format);           // apply_patch 在真表下标 6，lark 定义原样
    expect(after[0].required).toEqual(before[0].required);       // ['cmd'] 原样
    expect(after[0].parameters.properties.cmd.type).toBe('string');
  });

  test('enum 的取值留着，只砍取值上的说明文字', () => {
    const tools = [{ type: 'function', name: 'run', description: 'Run it now.',
      parameters: { type: 'object', properties: { k: { type: 'string', description: 'which key', enum: ['a', 'b'] } } } }];
    const M = load('aggressive');
    const r = M.handler({ tools, messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].parameters.properties.k.enum).toEqual(['a', 'b']);
    expect(r.tools[0].parameters.properties.k).not.toHaveProperty('description');
  });

  test('🔴 组合 schema（$ref / oneOf）整条跳过：遍历假设不成立时宁可不动', () => {
    const longDesc = 'A long description here that is definitely longer than the light budget of one hundred and ten characters, so it must get trimmed.';
    const tools = [{ type: 'function', name: 'combo', description: longDesc,
      parameters: { type: 'object', properties: { x: { $ref: '#/defs/X' } }, oneOf: [{ required: ['x'] }] } }];
    const M = load('light');
    const r = M.handler({ tools, messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].parameters.oneOf).toEqual([{ required: ['x'] }]);
    expect(r.tools[0].parameters.properties.x.$ref).toBe('#/defs/X');
  });
});

describe('tools-summary-downgrade · 省多少 / 漂不漂', () => {
  test('aggressive 的 saved 明显大于 light（真表构成：parameters 52% > description 32%）', () => {
    const light = fresh('light').r;
    const aggr = fresh('aggressive').r;
    expect(light.saved).toBeGreaterThan(0);
    expect(aggr.saved).toBeGreaterThan(light.saved);
  });

  test('stable=true：同一份输入两次压出完全一样的请求体（lazyload 的 kept 每轮漂的对立面）', () => {
    const { M } = fresh('aggressive');
    const a = M.handler({ tools: JSON.parse(JSON.stringify(REAL)), messages: [], agentType: 'coding' }, {});
    const b = M.handler({ tools: JSON.parse(JSON.stringify(REAL)), messages: [], agentType: 'coding' }, {});
    expect(a.stable).toBe(true);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });

  test('截断不切出半句话：优先压在句号/分句边界，且短于下限时原样返回', () => {
    const { M } = fresh('light');
    const trimmed = M.trimDescription('Runs a command in a PTY. Returning output or a session id now.', 40);
    expect(trimmed).toBe('Runs a command in a PTY.');      // 句号断点，不加省略号
    const commaTrimmed = M.trimDescription('Runs a command in a PTY, returning output.', 40);
    expect(commaTrimmed).not.toContain('…');               // 逗号也算断点
    const hardCut = M.trimDescription('abcdefghij klmnopqrst uvwxyz0123456789ABCDEFGHIJK', 40);
    expect(hardCut).toContain('…');                        // 找不到断点才硬切 + 省略号
    expect(M.trimDescription('Short.', 200)).toBe('Short.');
    expect(M.trimDescription('', 100)).toBe('');
    expect(typeof M.trimDescription('x'.repeat(500), 60)).toBe('string');
  });
});

describe('tools-summary-downgrade · 剥参数说明只归 aggressive（59 号真链路事故回归）', () => {
  // 事故背景：真链路上开 aggressive 跑 codex 任务，模型给 exec_command 传了 justification、
  // 被 codex 客户端拒（justification 需要显式 sandbox_permissions）—— 它就写在 justification 自己的
  // description 里。说明被删 ⇒ 模型不知道要显式授权 ⇒ 调用直接失败。这不是「少省一点」，是能力事故。
  // description 必须长到两档都能压（否则 light 会走 changedCount=0 → 返回 null，
  // 变成「没触发」而不是「没剥参数」，用例就测不到开关了）。
  const JUST = [{
    type: 'function', name: 'exec_command',
    description: 'Runs a command in a PTY, returning output or a session id for ongoing interaction. '
      + 'Use it to run shell commands such as git status, ls, or node -v.',
    parameters: { type: 'object', properties: {
      just: { type: 'string', description: 'Justification for running this command, requires explicit sandbox permissions.' },
    }, required: ['just'] },
  }];

  test('🔴 出事那条字段现在被保护名单挡住：justification 的说明一个字都不许删', () => {
    const M = load('aggressive');
    const r = M.handler({ tools: JSON.parse(JSON.stringify(JUST)), messages: [], agentType: 'coding' }, {});
    expect(r).not.toBeNull();
    expect(r.tools[0].parameters.properties.just).toHaveProperty('description');
    expect(r.tools[0].parameters.properties.just.description).toContain('sandbox permissions');
    expect(r.tools[0].parameters.properties.just.type).toBe('string');   // 字段本身本来就不会动
  });

  test('非保护语义的参数说明照样剥（保护名单不能变成一刀切不开）', () => {
    const tools = [{ type: 'function', name: 'read_file', description:
        'Reads a file from the workspace and returns its contents as text.',
      parameters: { type: 'object', properties: {
        p: { type: 'string', description: 'The file to read.' },
      }, required: ['p'] } }];
    const M = load('aggressive');
    const r = M.handler({ tools, messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].parameters.properties.p).not.toHaveProperty('description');
    expect(r.tools[0].parameters.properties.p.type).toBe('string');
  });

  test('保护名单覆盖常见安全/格式措辞（权限、绝对路径、编码、枚举格式）', () => {
    const cases = [
      'Requires explicit sandbox permissions to run.',
      'Only absolute paths are allowed here.',
      'Must be UTF-8 encoded.',
      'The expected format is a lark grammar.',
      'Use the file path to the resource, relative to the workspace root.',
    ];
    for (const d of cases) expect(M_aggressive().isProtectedDesc(d)).toBe(true);
    for (const d of ['The command to execute.', 'Which key to look up.', 'Number of retries.'])
      expect(M_aggressive().isProtectedDesc(d)).toBe(false);
    function M_aggressive() { return load('aggressive'); }
  });

  test('🔴 light 一律不碰 parameters 说明（开关按档位查，不按 cfg 合并）', () => {
    const M = load('light');
    const r = M.handler({ tools: JSON.parse(JSON.stringify(JUST)), messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].parameters.properties.just.description).toBe(
      'Justification for running this command, requires explicit sandbox permissions.');
  });

  // 对比用的必须是**非保护**字段：保护字段在两档下都留着，测不出档位差异。
  // description 同样要长到两档都能压（light 上限 110 字符），否则 light 直接返回 null，
  // 对比就退化成「没触发」而非「没剥参数」。
  const PLAIN = [{
    type: 'function', name: 'read_file', description:
      'Reads a file from the workspace and returns its contents as text, '
      + 'handling large files by streaming them back in chunks instead of holding them all in memory at once.',
    parameters: { type: 'object', properties: {
      n: { type: 'integer', description: 'Number of lines to read.' },
    }, required: ['n'] },
  }];

  test('🔴 回归：档位开关写在模块级表里，handler 必须按 mode 回查（读 cfg 会恒为 undefined）', () => {
    // 曾经把开关从 DEFAULTS 挪到 STRIP_PARAM_DESC 表，但 handler 里还留着 cfg.stripParamDesc，
    // 于是 aggressive 静默失去剥参数的能力、单测还全绿（用例只断言了「字段还有 description 吗」的反面）。
    const aggr = load('aggressive').handler({ tools: JSON.parse(JSON.stringify(PLAIN)), messages: [], agentType: 'coding' }, {});
    const lgt = load('light').handler({ tools: JSON.parse(JSON.stringify(PLAIN)), messages: [], agentType: 'coding' }, {});
    expect(aggr.tools[0].parameters.properties.n).not.toHaveProperty('description');
    expect(lgt.tools[0].parameters.properties.n).toHaveProperty('description');
    // 且 aggressive 的节省必须真的更大（剥参数是它省得更多的直接原因）
    expect(aggr.saved).toBeGreaterThan(lgt.saved);
  });

  test('保护字段在 light / aggressive 两档下都原样留着（安全语义不该被省掉）', () => {
    for (const mode of ['light', 'aggressive']) {
      const r = load(mode).handler({ tools: JSON.parse(JSON.stringify(JUST)), messages: [], agentType: 'coding' }, {});
      if (!r) continue;                       // light 可能只压了 description 就够，返回 null 也算没动参数
      expect(r.tools[0].parameters.properties.just).toHaveProperty('description');
    }
  });

  test('env 强制覆盖仍能钉死开关（1=两档都剥 / 0=两档都不剥）', () => {
    const p = require.resolve(MOD);
    process.env.CURATOR_SUMMARY_MODE = 'light';
    process.env.CURATOR_SUMMARY_STRIP_PARAM_DESC = '1';
    let M;
    jest.isolateModules(() => { M = require(p); });
    const r = M.handler({ tools: JSON.parse(JSON.stringify(PLAIN)), messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].parameters.properties.n).not.toHaveProperty('description');
    delete process.env.CURATOR_SUMMARY_STRIP_PARAM_DESC;
  });
});

describe('tools-summary-downgrade · balanced 中间档（拿 aggressive 的省量、避开它的失败模式）', () => {
  const LONG_PARAMS = [{
    type: 'function', name: 'read_file', description:
      'Reads a file from the workspace and returns its contents as text, '
      + 'handling large files by streaming them back in chunks instead of holding them all in memory at once.',
    parameters: { type: 'object', properties: {
      n: { type: 'integer', description: 'Number of lines to read, capped at ten thousand.' },
      p: { type: 'string', description: 'Target file to open.' },   // 别写 path to/absolute：会被保护名单吃掉，测不出「剥了」
    }, required: ['n'] },
  }];

  test('balanced 剥非保护参数说明，但 description 一个字符都不压（balancedMaxChars=Infinity）', () => {
    const M = load('balanced');
    const r = M.handler({ tools: JSON.parse(JSON.stringify(LONG_PARAMS)), messages: [], agentType: 'coding' }, {});
    expect(r).not.toBeNull();
    expect(r.tools[0].parameters.properties.n).not.toHaveProperty('description');
    expect(r.tools[0].parameters.properties.p).not.toHaveProperty('description');
    // 🔴 关键：这条 description 长到 light 都会压（>110 字符），balanced 下必须原样留着
    expect(r.tools[0].description.length).toBeGreaterThan(110);
    expect(r.tools[0].description).not.toContain('…');
  });

  // 58 号那批「parameters 52% / description 32%」是在**整表 3,689 tok 的真表**上扫出来的，
  // 单测夹具带不动那么多字（上面的 REAL 是摘要版，参数说明本就被砍过）。
  // 所以这里**构造一张 parameters 密集的表**来验机制本身：剥参数这一层的省量必须大于压 description 那一层
  // —— balanced 的定位就落在这条上，真表上的具体数字记在 58 号与真链路验证文档里，别在这里重复。
  const DENSE = [{
    type: 'function', name: 'exec_command', description:
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction, '
      + 'so a single call can both produce output and leave an interactive session behind.',
    strict: false,
    parameters: { type: 'object', properties: {
      cmd: { type: 'string', description: 'The shell command to execute in the PTY session.' },
      mode: { type: 'string', description: 'Whether the session waits for the command to finish or returns immediately.' },
      cwd: { type: 'string', description: 'The working directory the command runs in.' },
      env: { type: 'object', description: 'Extra environment variables forwarded to the process.' },
      timeout: { type: 'integer', description: 'How long to wait before killing the command.' },
    }, required: ['cmd'] },
  }];
  const runDense = (mode) => load(mode).handler(
    { tools: JSON.parse(JSON.stringify(DENSE)), messages: [], agentType: 'coding' }, {});

  test('省量顺序 light < balanced < aggressive；balanced 的省量大头来自 parameters 这一层', () => {
    const light = runDense('light');
    const bal = runDense('balanced');
    const aggr = runDense('aggressive');
    expect(light.saved).toBeGreaterThan(0);
    expect(bal.saved).toBeGreaterThan(light.saved);   // 只剥参数 > 只压 description
    expect(bal.saved).toBeLessThan(aggr.saved);       // aggressive 还额外压了 description
    // 大头（>50%）来自参数说明这一层 —— 这是 balanced 存在的全部理由
    expect(bal.saved / aggr.saved).toBeGreaterThan(0.5);
  });

  test('balanced 相对 light 的增量 = 被剥掉的参数说明（不是 description 那部分）', () => {
    const light = runDense('light');
    const bal = runDense('balanced');
    // balanced 不截 description（只做空白归一）⇒ 它保留的句子比 light 截断出来的更长，
    // 差额只能来自 parameters ⇒ 这条把「增量来源」钉死，防止哪天两档的作用悄悄互换。
    expect(bal.tools[0].description.length).toBeGreaterThan(light.tools[0].description.length);
    expect(bal.tools[0].description).toContain('so a single call can both produce output');
    expect(bal.saved - light.saved).toBeGreaterThan(0);
    Object.keys(DENSE[0].parameters.properties).forEach((k) => {
      expect(bal.tools[0].parameters.properties[k]).not.toHaveProperty('description');
    });
  });

  // A/B 探针上真踩到：P3 早期只认 codex 的**扁平** shape（顶层 description/parameters），
  // 喂 OpenAI 的嵌套 shape（function.{name,description,parameters}）时那些字段全是 undefined
  // ⇒ 一个字不改、handler 返回 null，桥那侧看起来就是「这轮没触发」——一次静默失效。
  // 真链路上没炸只因为 codex 发扁平；上游或客户端一换形状就废。两套都必须压。
  const NESTED = [{
    type: 'function',
    function: { name: 'exec_command', description:
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction. '
      + 'Use it to run shell commands such as git status, ls, or node -v.',
      parameters: { type: 'object', properties: {
        cmd: { type: 'string', description: 'The shell command to execute in the PTY session.' },
      }, required: ['cmd'] } },
  }];

  test('🔴 两种工具形状都压得动：codex 扁平 shape 与 OpenAI 嵌套 shape', () => {
    for (const mode of ['balanced', 'aggressive']) {
      const M = load(mode);
      const r = M.handler({ tools: JSON.parse(JSON.stringify(NESTED)), messages: [], agentType: 'coding' }, {});
      expect(r).not.toBeNull();                     // 旧实现在这里是 null（静默失效）
      expect(r.tools[0].function.parameters.properties.cmd).not.toHaveProperty('description');
      expect(r.tools[0].function.name).toBe('exec_command');
      // 扁平对照：同一份内容换扁平形状，省量应当一致（见下一条）
      const flat = JSON.parse(JSON.stringify(NESTED.map((t) => Object.assign({}, t, t.function, { function: undefined }, { parameters: t.function.parameters }))));
      const rf = M.handler({ tools: flat, messages: [], agentType: 'coding' }, {});
      expect(rf).not.toBeNull();
      expect(rf.saved).toBe(r.saved);
    }
  });

  test('嵌套形状下 description 也照压（aggressive 把 function.description 收短）', () => {
    const r = load('aggressive').handler({ tools: JSON.parse(JSON.stringify(NESTED)), messages: [], agentType: 'coding' }, {});
    expect(r.tools[0].function.description.length).toBeLessThan(NESTED[0].function.description.length);
    expect(r.tools[0].function.description).not.toContain('Use it to run shell commands');
  });

  test('🔴 balanced 也走安全契约保护名单：justification 那句在任何档位都留着', () => {
    // 配一条非保护参数（retries），否则整表只剩保护字段 ⇒ changed=0 ⇒ handler 返回 null，
    // 用例就退化成「没触发」而不是「保护名单生效」。
    const JUST_ENTRY = [{
      type: 'function', name: 'exec_command', description: 'Runs a command in a PTY.',
      parameters: { type: 'object', properties: {
        just: { type: 'string', description: 'Justification for running this command, requires explicit sandbox permissions.' },
        retries: { type: 'integer', description: 'How many times to retry the call on failure.' },
      }, required: ['just'] },
    }];
    const r = load('balanced').handler({ tools: JSON.parse(JSON.stringify(JUST_ENTRY)), messages: [], agentType: 'coding' }, {});
    expect(r).not.toBeNull();                       // 非保护那条得真的被剥了，否则这条用例什么也没测
    expect(r.tools[0].parameters.properties.retries).not.toHaveProperty('description');
    expect(r.tools[0].parameters.properties.just).toHaveProperty('description');
    expect(r.tools[0].parameters.properties.just.description).toContain('sandbox permissions');
  });

  test('balanced 依然不删工具、不改 total（P3 相对于 lazyload 的全部价值都在「不变」上）', () => {
    const M = load('balanced');
    const r = M.handler({ tools: JSON.parse(JSON.stringify(REAL)), messages: [], agentType: 'coding' }, {});
    expect(r.tools.length).toBe(REAL.length);
    expect(r.total).toBe(REAL.length);
    expect(r.stable).toBe(true);
  });

  test('balanced 落在白名单里：拼错当成 off（别让悄悄改写请求体）', () => {
    expect(() => load('balanced')).not.toThrow();
    expect(load('balanced').handler({ tools: [], messages: [], agentType: 'coding' }, {})).toBeNull();
  });
});

describe('tools-summary-downgrade · 与 tools-lazyload 互斥', () => {
  test('CURATOR_SUMMARY_MODE 非 off 时 lazyload 直接让位（否则桥会写两次 tools）', () => {
    const LAZYP = require.resolve('../../../packs/curator/policies/tools-lazyload.js');
    process.env.CURATOR_SUMMARY_MODE = 'aggressive';
    let LAZY;
    jest.isolateModules(() => { LAZY = require(LAZYP); });
    const r = LAZY.handler({ tools: REAL, messages: [], agentType: 'coding' }, { budget: {} });
    expect(r.reason).toBe('summary-mode-active');
    delete process.env.CURATOR_SUMMARY_MODE;
  });
});
