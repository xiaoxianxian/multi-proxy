/**
 * M6 方向四 · 按任务类型智能派发路由 单元测试
 * 覆盖：4a classifyTask / 4b evaluateRules(白名单,禁 eval) / 4c cost-optimization
 *      D12 修复（round-robin 按 config.id 分桶，不串号）/ M6-D 默认四层配置
 */
import {
  classifyTask,
  RouteEngine,
  DEFAULT_ROUTE_CONFIG,
  type RouteConfig,
} from '../../src/routing/routeEngine.js';
import {
  evaluateCondition,
  evaluateRules,
  estimateCost,
  rankByCost,
} from '../../src/routing/ruleEvaluator.js';

// ---------- 4a classifyTask ----------
describe('M6-4a classifyTask', () => {
  it('图片/视觉信号 → vision', () => {
    expect(classifyTask([
      { role: 'user', content: '帮我识别这张图片里的文字' },
    ])).toBe('vision');
    expect(classifyTask([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x/a.png' } }] },
    ])).toBe('vision');
    expect(classifyTask([
      { role: 'user', content: '这张截图的报错怎么解决' },
    ])).toBe('vision');
  });

  it('代码特征 → coding', () => {
    expect(classifyTask([{ role: 'user', content: '修复 src/app.ts 里的 bug：空指针' }])).toBe('coding');
    expect(classifyTask([
      { role: 'user', content: '实现一个排序函数\n```ts\nfunction sort(a){}\n```' },
    ])).toBe('coding');
    expect(classifyTask([{ role: 'user', content: 'git commit 怎么回退上一个提交' }])).toBe('coding');
  });

  it('写作特征 → writing', () => {
    expect(classifyTask([{ role: 'user', content: '帮我润色这篇公众号文章的开头' }])).toBe('writing');
    expect(classifyTask([{ role: 'user', content: '把这段总结成一篇文章' }])).toBe('writing');
  });

  it('短消息+翻译信号 → cheap', () => {
    expect(classifyTask([{ role: 'user', content: '把 hello world 翻译成英文' }])).toBe('cheap');
    expect(classifyTask([{ role: 'user', content: '缩写这段话' }])).toBe('cheap');
  });

  it('无明显特征 → general', () => {
    expect(classifyTask([{ role: 'user', content: '今天天气怎么样' }])).toBe('general');
    expect(classifyTask([{ role: 'user', content: '讲个笑话' }])).toBe('general');
  });

  it('优先级：vision 高于 coding（含图+代码词时仍归 vision）', () => {
    const t = classifyTask([{ role: 'user', content: '看图帮我重构这段代码' }]);
    expect(['vision', 'coding']).toContain(t);
  });
});

// ---------- 4b evaluateCondition / evaluateRules ----------
describe('M6-4b 规则条件求值器', () => {
  it('taskType == 字面 命中 / 不命中', () => {
    expect(evaluateCondition("taskType == 'coding'", { taskType: 'coding' })).toBe(true);
    expect(evaluateCondition("taskType == 'coding'", { taskType: 'writing' })).toBe(false);
  });

  it('model.contains(x) 白名单方法', () => {
    expect(evaluateCondition("model.contains('vision')", { model: 'glm-5.3-vision' })).toBe(true);
    expect(evaluateCondition("model.contains('vision')", { model: 'glm-5.3-flash' })).toBe(false);
  });

  it('AND / OR 组合', () => {
    expect(evaluateCondition("provider == 'glm' && model.contains('flash')", { provider: 'glm', model: 'glm-flash' })).toBe(true);
    expect(evaluateCondition("taskType == 'cheap' || model.contains('agnes')", { taskType: 'writing', model: 'agnes-2.5-flash' })).toBe(true);
    expect(evaluateCondition("taskType == 'cheap' || model.contains('agnes')", { taskType: 'writing', model: 'qwen' })).toBe(false);
  });

  it('布尔字面量与括号', () => {
    expect(evaluateCondition('privacy == true', { privacy: true })).toBe(true);
    expect(evaluateCondition('(taskType == "coding") && quality == "high"', { taskType: 'coding', quality: 'high' })).toBe(true);
   });

  it('白名单外字段 → 降级 false（不命中），主链路不崩', () => {
    expect(evaluateCondition("process.exit() == 0", {})).toBe(false);
    expect(evaluateCondition("secret == 'x'", {})).toBe(false);
   });

  it('语法错误 → 降级 false', () => {
    expect(evaluateCondition("taskType == ", {})).toBe(false);
    expect(evaluateCondition("model.contains('foo'", {})).toBe(false);
   });

  it('逐条 evaluateRules 返回首个命中', () => {
    const rules = [
     { id: 'a', condition: "taskType == 'writing'", targetProvider: 'writer' },
     { id: 'b', condition: "taskType == 'coding'", targetProvider: 'coder' },
    ];
    expect(evaluateRules(rules, { taskType: 'coding' })).toBe('coder');
    expect(evaluateRules(rules, { taskType: 'writing' })).toBe('writer');
    expect(evaluateRules(rules, { taskType: 'vision' })).toBeNull();
    expect(evaluateRules(undefined, {})).toBeNull();
  });
});

// ---------- 4c cost-optimization ----------
describe('M6-4c cost-optimization', () => {
  it('estimateCost 基本公式', () => {
      // input 1e6 tokens × 0.8/1e6 + output 1e6 × 2.7/1e6 = 0.8 + 2.7 = 3.5
    expect(estimateCost({ input: 0.8, output: 2.7 }, 1_000_000, 1_000_000)).toBeCloseTo(3.5, 6);
    expect(estimateCost(undefined, 10, 10)).toBe(Infinity); // 无定价 → 最贵
   });

  it('rankByCost 健康优先、其次花费升序', () => {
    const cands = [
      { id: 'free-down', pricing: { input: 0, output: 0 }, health: 'down' as const },
      { id: 'cheap-ok', pricing: { input: 0.8, output: 2.7 }, health: 'ok' as const },
      { id: 'pricey-ok', pricing: { input: 5, output: 20 }, health: 'ok' as const },
      { id: 'free-ok', pricing: { input: 0, output: 0 }, health: 'ok' as const },
      ];
      const ranked = rankByCost(cands, 1000, 100);
     // 健康 ok 优先于 down：free_ok(0) 排最前，free_down 沉底
    expect(ranked[0].id).toBe('free-ok');
    expect(ranked[ranked.length - 1].id).toBe('free-down');
    expect(ranked[1].id).toBe('cheap-ok');
   });

  it('RouteEngine cost-optimization 在有候选集时选最便宜且健康', () => {
    const eng = new RouteEngine();
    const cfg: RouteConfig = {
      id: 'c1',
      defaultModel: 'expensive',
      fallbackChain: ['expensive', 'mid', 'cheap'],
      rules: [],
      maxRetries: 3,
      strategy: 'cost-optimization',
      };
    const target = eng.getNextRoute('general', 'm', cfg, {
      candidates: [
        { id: 'expensive', pricing: { input: 5, output: 20 }, health: 'ok' },
        { id: 'cheap',     pricing: { input: 0,  output: 0  }, health: 'down' },
        { id: 'mid',       pricing: { input: 1,  output: 4  }, health: 'ok' },
       ],
      messageLength: 1000,
      });
     // 'cheap' 虽最便宜但 down，应选下一个 ok 的 'mid'
    expect(target).toBe('mid');
    });

  it('默认无候选集 + 有 pricing → 选最便宜的 fallback 项', () => {
    const eng = new RouteEngine();
    const cfg: RouteConfig = {
      id: 'c2',
      defaultModel: 'd',
      fallbackChain: ['a', 'b', 'c'],
      rules: [],
      maxRetries: 3,
      strategy: 'cost-optimization',
      pricing: {
        a: { input: 5, output: 20 },
        b: { input: 0, output: 0 },
        c: { input: 1, output: 4 },
        },
      };
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('b');
    });
});

// ---------- D12 修复：round-robin 按 config.id 分桶 ----------
describe('M6 D12 round-robin 分桶不串号', () => {
  it('两个不同 config 各自独立计数，互不干扰', () => {
    const eng = new RouteEngine();
    const cfgA: RouteConfig = { id: 'A', defaultModel: 'a0', fallbackChain: ['a0', 'a1', 'a2'], rules: [], maxRetries: 3, strategy: 'round-robin' };
    const cfgB: RouteConfig = { id: 'B', defaultModel: 'b0', fallbackChain: ['b0', 'b1'],       rules: [], maxRetries: 3, strategy: 'round-robin' };
     // 交替调用：A,B,A,B
    const seqAB = [
      eng.getNextRoute('general', 'm', cfgA),
      eng.getNextRoute('general', 'm', cfgB),
      eng.getNextRoute('general', 'm', cfgA),
      eng.getNextRoute('general', 'm', cfgB),
       ];
     expect(seqAB).toEqual([
       cfgA.fallbackChain[1], // A: 1st → next=1（pre-increment，与既有 round-robin 契约一致）
       cfgB.fallbackChain[1], // B: 1st → next=1，且与 A 桶独立
       cfgA.fallbackChain[2], // A: 2nd → next=2
       cfgB.fallbackChain[0], // B: 2nd → next=0（回绕），仍不串到 A 桶
        ]);
    });

  it('round-robin 取模回绕', () => {
    const eng = new RouteEngine();
    const cfg: RouteConfig = { id: 'wrap', defaultModel: 'w0', fallbackChain: ['w0', 'w1'], rules: [], maxRetries: 3, strategy: 'round-robin' };
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('w1'); // next = (0+1)%2 = 1
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('w0'); // next = (1+1)%2 = 0（回绕）
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('w1'); // next = (0+1)%2 = 1
   });

  it('空 fallbackChain 时回退 defaultModel', () => {
    const eng = new RouteEngine();
    const cfg: RouteConfig = { id: 'empty', defaultModel: 'def', fallbackChain: [], rules: [], maxRetries: 3, strategy: 'round-robin' };
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('def');
   });
});

// ---------- 规则优先于 strategy ----------
describe('M6 规则求值优先于 strategy 分支', () => {
  it('命中规则直达 targetProvider，跳过 strategy', () => {
    const eng = new RouteEngine();
    const cfg: RouteConfig = {
      id: 'rule-first',
      defaultModel: 'd',
      fallbackChain: ['d', 'x'],
      rules: [{ id: 'r1', condition: "taskType == 'cheap'", targetProvider: 'agnes' }],
      maxRetries: 3,
      strategy: 'priority',
       };
     // 即便 strategy=priority（应返 fallbackChain[0]='d'），规则命中却返 'agnes'
    expect(eng.getNextRoute('cheap', 'm', cfg)).toBe('agnes');
     // 规则不命中时走 priority
    expect(eng.getNextRoute('writing', 'm', cfg)).toBe('d');
   });
});

// ---------- M6-D 默认四层配置 ----------
describe('M6-D 默认四层 RouteConfig', () => {
  it('默认配置结构完整', () => {
    expect(DEFAULT_ROUTE_CONFIG.id).toBe('default-four-tier');
    expect(DEFAULT_ROUTE_CONFIG.strategy).toBe('cost-optimization');
    expect(DEFAULT_ROUTE_CONFIG.fallbackChain).toEqual(['qwen3.8-flash', 'deepseek-v4.1-flash', 'agnes-2.5-flash', 'qwen3.8:27b-mlx']);
    expect(DEFAULT_ROUTE_CONFIG.pricing).toBeDefined();
    expect(Object.keys(DEFAULT_ROUTE_CONFIG.pricing!)).toContain('qwen3.8-flash');
   });

  it('coding 任务命中 r-coding → deepseek-v4.1-flash', () => {
    const eng = new RouteEngine();
    const t = eng.getNextRoute('coding', 'deepseek-v4.1-flash', DEFAULT_ROUTE_CONFIG);
    expect(t).toBe('deepseek-v4.1-flash');
   });

  it('cheap 任务命中 r-cheap → agnes-2.5-flash', () => {
    const eng = new RouteEngine();
    expect(eng.getNextRoute('cheap', 'm', DEFAULT_ROUTE_CONFIG)).toBe('agnes-2.5-flash');
   });

  it('privacy==true 命中 → 本地离线 qwen3.8:27b-mlx', () => {
    const eng = new RouteEngine();
    expect(eng.getNextRoute('general', 'm', DEFAULT_ROUTE_CONFIG, { privacy: true })).toBe('qwen3.8:27b-mlx');
   });
});