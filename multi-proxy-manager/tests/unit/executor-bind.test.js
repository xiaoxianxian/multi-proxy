'use strict';

// executor-bind 单测 —— 验证「路由选中 adapter → 真调那个 adapter」的接线是对的。
//
// 隔离纪律：下游是内联 mock（mock-l1 + mock-h3web，127.0.0.1 随机端口），
//   0 联网 / 0 扣费 / 0 外发；端口经 env 注入（PROXY_CODEX_PORTS / PROXY_H3WEB_PORTS），
//   绝不写死，也不碰真实 codex-proxy(18790) / h3web(8731)。
// 门控纪律：PROXY_EXECUTOR_BIND 默认 0 → 接线不上；测试用完必清 env，防污染其它套件。

const path = require('path');
const L2 = path.join(__dirname, '../../../l2');
const { createBoundExecutor, isExecutorBindOpen, isTierBindOpen, UnboundAdapterError, BINDING_DEFS } = require(path.join(L2, 'executor-bind.js'));
const rb = require(path.join(L2, 'knowledge-base/routing-base.js'));
const startMockL1 = require(path.join(L2, 'mock-l1.js'));
const startMockH3web = require(path.join(L2, 'mock-h3web.js'));
const { RouteEngine } = require(path.join(L2, 'route-engine.js'));
const { AgentRegistry } = require(path.join(L2, 'agent-registry.js'));
const { seedDefaultProfiles } = require(path.join(L2, 'mcp-default-seed.js'));

const BIND_ENV = ['PROXY_EXECUTOR_BIND', 'PROXY_CODEX_PORTS', 'PROXY_H3WEB_PORTS',
    'PROXY_CLAUDE_PORTS', 'PROXY_AUTH_TOKEN', 'PROXY_H3WEB_POLL_MS', 'PROXY_H3WEB_MAX_TRIES',
    // 三档 tier（待办 6）
    'PROXY_TIER_BIND', 'PROXY_TIER_LOCAL_ONLY',
    'PROXY_AGNES_PORTS', 'PROXY_DEEPSEEK_PORTS', 'PROXY_QWEN_PORTS'];

function cleanEnv() { BIND_ENV.forEach((k) => delete process.env[k]); }

// mock 端口就绪等待：listen(0) 是异步绑定，直接 getPort() 可能拿到 null →
// String(null)==='null' → envPorts 解析失败 → 静默回退默认候选（8731 真实 h3web！）。
// 这是**隔离纪律**问题：宁可显式失败，也不能让测试误连真实下游。
async function waitPort(getter, timeoutMs = 3000) {
    const t0 = Date.now();
    for (;;) {
        let p = null;
        try { p = getter(); } catch { p = null; }   // listen(0) 未 bind 时 address() 为 null
        if (typeof p === 'number' && p > 0) return p;
        if (Date.now() - t0 > timeoutMs) throw new Error('mock 端口未就绪（listen(0) 未绑定）');
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe('executor-bind · 门控', () => {
    afterEach(cleanEnv);

    test('默认（无 env）门控关闭 —— 生产零行为变更的前提', () => {
        cleanEnv();
        expect(isExecutorBindOpen()).toBe(false);
    });

    test('PROXY_EXECUTOR_BIND=1/on/true 才开门，其它值一律关', () => {
        for (const v of ['1', 'on', 'true', 'TRUE']) {
            process.env.PROXY_EXECUTOR_BIND = v;
            expect(isExecutorBindOpen()).toBe(true);
        }
        for (const v of ['0', '', 'yes', '2']) {
            process.env.PROXY_EXECUTOR_BIND = v;
            expect(isExecutorBindOpen()).toBe(false);
        }
    });

    test('绑定表只含有真实 adapter 类的三档（h3web/codex/claude）', () => {
        expect(BINDING_DEFS.map((d) => d.adapterId).sort()).toEqual(['claude', 'codex', 'h3web']);
    });
});

describe('executor-bind · 分发真跑（内联 mock 下游）', () => {
    let mockL1 = null;
    let mockH3 = null;
    let bound = null;

    let l1Port = null;
    let h3Port = null;

    beforeAll(async () => {
        mockL1 = startMockL1(0, { model: 'bind-test-model' });
        mockH3 = startMockH3web(0);
        l1Port = await waitPort(() => mockL1.getPort());
        h3Port = await waitPort(() => mockH3.getPort());
        bound = createBoundExecutor({ logger: { log: () => {}, warn: () => {} } });
    });

    // ⚠️ env 必须在 beforeEach 设，不能只在 beforeAll：jest.setup-afterenv.js 有全局
    // afterEach 把 process.env 恢复到 worker 快照（防跨文件泄漏）→ beforeAll 设的 env
    // 在第二个 test 就消失了（曾表现为 h3web 静默回退默认候选 8731 → 探测失败 → 连 :80）。
    beforeEach(() => {
        process.env.PROXY_CODEX_PORTS = String(l1Port);
        process.env.PROXY_H3WEB_PORTS = String(h3Port);
        process.env.PROXY_H3WEB_POLL_MS = '20';      // 加速轮询（生产默认 2000ms，测试不睡）
        process.env.PROXY_AUTH_TOKEN = mockL1.token; // mock-l1 要求 x-proxy-auth
    });

    afterAll(async () => {
        if (mockL1) await mockL1.close();
        if (mockH3) await mockH3.close();
        cleanEnv();
    });

    test('codex → L1 chat 真往返（下游真收到请求，不是空转）', async () => {
        const before = mockL1.getChatCalls();
        const v = await bound.executor('codex', { id: 's1', type: 'code', prompt: '写一个 jwt 中间件' });
        expect(v.adapterId).toBe('codex');
        expect(v.bound).toBe(true);
        expect(mockL1.getChatCalls()).toBe(before + 1);
        expect(v.content).toBe('mock-ok');
    });

    test('h3web → /api/gen + /api/status 真走 job 状态机到终态', async () => {
        const before = mockH3.getGenCalls();
        const v = await bound.executor('h3web', { id: 's2', type: 'video', prompt: '生成一段视频' });
        expect(v.adapterId).toBe('h3web');
        expect(v.kind).toBe('task-queue');
        expect(mockH3.getGenCalls()).toBe(before + 1);     // 真提交了 job
        expect(mockH3.getStatusCalls()).toBeGreaterThanOrEqual(2); // pending/running → done 至少轮询两次
        expect(v.status).toBe('done');
    });

    test('未绑定 adapterId（agnes 三档 tier）→ 硬抛 UnboundAdapterError，绝不静默降级', async () => {
        await expect(bound.executor('agnes', { id: 's3', type: 'plan', prompt: '做个计划' }))
            .rejects.toThrow(UnboundAdapterError);
        await expect(bound.executor('agnes', { id: 's3', type: 'plan', prompt: 'x' }))
            .rejects.toThrow(/未绑定真实 adapter/);
    });

    test('describe() 暴露绑定清单（运维可见性）', () => {
        const d = bound.describe();
        expect(d.map((x) => x.adapterId)).toEqual(expect.arrayContaining(['h3web', 'codex', 'claude']));
        expect(d.every((x) => typeof x.kind === 'string' && x.desc)).toBe(true);
    });
});

describe('executor-bind · REST 入口形态 forOrchestrator(routeEngine)', () => {
    let mockL1 = null;
    let bound = null;
    let registry = null;
    let routeEngine = null;

    let l1Port = null;

    beforeAll(async () => {
        mockL1 = startMockL1(0, { model: 'bind-rest-model' });
        l1Port = await waitPort(() => mockL1.getPort());
        registry = new AgentRegistry();
        seedDefaultProfiles(registry);
        routeEngine = new RouteEngine({ registry, shadowMode: true });
        bound = createBoundExecutor({ logger: { log: () => {}, warn: () => {} } });
    });

    // 同上：env 逐 test 重设（jest.setup-afterenv.js 的全局 env 快照恢复会清掉 beforeAll 设的值）
    beforeEach(() => {
        process.env.PROXY_CODEX_PORTS = String(l1Port);
        process.env.PROXY_AUTH_TOKEN = mockL1.token;
    });

    afterAll(async () => {
        if (mockL1) await mockL1.close();
        cleanEnv();
    });

    test('路由选中 codex → 真调 codex（REST 入口不绕过路由）', async () => {
        const before = mockL1.getChatCalls();
        const executor = bound.forOrchestrator(routeEngine);
        const v = await executor({ id: 'r1', type: 'code', complexity: 'low', prompt: '写代码' });
        expect(v.adapterId).toBe('codex');
        expect(mockL1.getChatCalls()).toBe(before + 1);
    });

    test('路由无候选 → 硬失败（不静默执行）', async () => {
        const executor = bound.forOrchestrator(routeEngine);
        await expect(executor({ id: 'r2', type: 'audio-mix-no-owner', complexity: 'low', prompt: '混音' }))
            .rejects.toThrow();
    });

    test('未给 routeEngine → 直接抛错（接线缺件不静默）', async () => {
        await expect(bound.forOrchestrator(null)({ id: 'r3', type: 'code', prompt: 'x' }))
            .rejects.toThrow(/routeEngine/);
    });
});

// 三档 text-tier（agnes=small / deepseek=medium / qwen=large）—— runbook §4.5 待办 6。
// 拍板方案：复用 L1AgentAdapter（三档协议都是 OpenAI 兼容 chat，差异只有 {port, model}），
// 不写三个 adapter 类。端口/模型/鉴权全部来自共享底座 tierBindings。
// 隔离纪律：mockProxy 充当 codex-proxy :18790，mockLocal 充当本地 Ollama :11434。
//   0 联网 / 0 扣费 / 0 外发 —— 付费档的端口也被 env 指到 mock，绝不真打外网。
describe('executor-bind · 三档 text-tier（待办 6）', () => {
    let mockProxy = null;   // 代理档出口（agnes/deepseek 经它打付费外网；此处是 mock）
    let mockLocal = null;   // 本地档（qwen → Ollama，无鉴权）
    let proxyPort = null;
    let localPort = null;

    beforeAll(async () => {
        mockProxy = startMockL1(0, { model: 'agnes-2.0-flash' });
        mockLocal = startMockL1(0, { model: 'qwen3.8:27b-mlx', noAuth: true });
        proxyPort = await waitPort(() => mockProxy.getPort());
        localPort = await waitPort(() => mockLocal.getPort());
    });

    afterAll(async () => {
        if (mockProxy) await mockProxy.close();
        if (mockLocal) await mockLocal.close();
        cleanEnv();
    });

    // defs 在 createBoundExecutor() 时求值（env 那时读），故每个用例现建
    const buildBound = () => createBoundExecutor({ logger: { log: () => {}, warn: () => {} } });

    test('默认（PROXY_TIER_BIND 未设）→ 三档不绑，维持「未绑定硬失败」零行为变更', async () => {
        cleanEnv();
        expect(isTierBindOpen()).toBe(false);
        const b = buildBound();
        await expect(b.executor('agnes', { id: 't0', type: 'plan', prompt: 'x' }))
            .rejects.toThrow(UnboundAdapterError);
    });

    test('PROXY_TIER_BIND=1 → agnes/deepseek 走代理端口、qwen 走本地端口，各带档位 model', async () => {
        cleanEnv();
        process.env.PROXY_TIER_BIND = '1';
        process.env.PROXY_AUTH_TOKEN = mockProxy.token;
        process.env.PROXY_AGNES_PORTS = String(proxyPort);
        process.env.PROXY_DEEPSEEK_PORTS = String(proxyPort);
        process.env.PROXY_QWEN_PORTS = String(localPort);
        const b = buildBound();
        // 三档都进了绑定表（运维可见性）
        expect(b.describe().map((x) => x.adapterId)).toEqual(expect.arrayContaining(['agnes', 'deepseek', 'qwen']));

        const va = await b.executor('agnes', { id: 't1', type: 'plan', prompt: '理解诉求' });
        const vd = await b.executor('deepseek', { id: 't2', type: 'plan', prompt: '分镜脚本' });
        const vq = await b.executor('qwen', { id: 't3', type: 'plan', prompt: '复杂推理' });

        expect([va.tier, vd.tier, vq.tier]).toEqual(['small', 'medium', 'large']);
        expect([va.agent, vd.agent, vq.agent]).toEqual(['agnes', 'deepseek', 'qwen']);
        // 模型真按档位下发（不是同一个 model 打天下）
        expect(mockProxy.getChatModels()).toEqual(['agnes-2.0-flash', 'deepseek-v4-pro']);
        expect(mockLocal.getChatModels()).toEqual(['qwen3.8:27b-mlx']);
        expect(va.content).toBe('mock-ok');
    });

    test('PROXY_TIER_LOCAL_ONLY=1 → 三档全指本地端口（0 成本演练，付费侧 0 调用）', async () => {
        cleanEnv();
        process.env.PROXY_TIER_BIND = '1';
        process.env.PROXY_TIER_LOCAL_ONLY = '1';
        process.env.PROXY_QWEN_PORTS = String(localPort);
        const proxyBefore = mockProxy.getChatCalls();
        const b = buildBound();
        await b.executor('agnes', { id: 'l1', type: 'plan', prompt: 'x' });
        await b.executor('deepseek', { id: 'l2', type: 'plan', prompt: 'x' });
        expect(mockProxy.getChatCalls()).toBe(proxyBefore);    // 付费上游一次没打
        expect(mockLocal.getChatModels().slice(-2)).toEqual(['qwen3.8:27b-mlx', 'qwen3.8:27b-mlx']);
    });

    test('推理型模型 content 空 → 兜底取 reasoning（本地 qwen 实测坑，防静默空结果）', async () => {
        const mockReasoning = startMockL1(0, { reasoningOnly: true, noAuth: true });
        const rPort = await waitPort(() => mockReasoning.getPort());
        try {
            cleanEnv();
            process.env.PROXY_TIER_BIND = '1';
            process.env.PROXY_QWEN_PORTS = String(rPort);
            const b = buildBound();
            const v = await b.executor('qwen', { id: 't4', type: 'plan', prompt: '想清楚再答' });
            expect(v.content).toContain('mock 推理正文');
            expect(v.contentSource).toBe('reasoning');
        } finally {
            await mockReasoning.close();
            cleanEnv();
        }
    });

    test('底座单一事实源：update tierBindings → 档位 model 即刻生效；rollback 还原', async () => {
        cleanEnv();
        process.env.PROXY_TIER_BIND = '1';
        process.env.PROXY_AUTH_TOKEN = mockProxy.token;
        process.env.PROXY_AGNES_PORTS = String(proxyPort);
        const orig = rb.ROUTING_BASE.tierBindings;
        try {
            rb.update({
                tierBindings: { ...orig, small: { ...orig.small, model: 'patched-model' } },
            }, 'test: tier model');
            await buildBound().executor('agnes', { id: 't5', type: 'plan', prompt: 'x' });
            expect(mockProxy.getLastModel()).toBe('patched-model');
        } finally {
            rb.rollback();
        }
        await buildBound().executor('agnes', { id: 't6', type: 'plan', prompt: 'x' });
        expect(mockProxy.getLastModel()).toBe(orig.small.model);   // 回滚后回原档位模型
    });
});
