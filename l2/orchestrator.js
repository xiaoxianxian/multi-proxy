'use strict';

// Orchestrator — L2 P2 编排中枢核心：任务拆解 → 调度（拓扑 + 并行/串行/条件分支）→ 执行 → 聚合 → 协作历史。
// 蓝图 4.2 / 5.1。
//
// 设计原则（与 l2/ agent-registry / plugin-runtime / route-engine / decomposer 同构）：
//    - 非侵入④：协作历史默认仅内存；opts.dir 注入才落盘（原子写 .tmp→rename，绝不默认写 home/agent 文件）。
//    - 零依赖：仅 node 内置（fs/path 仅用于可选落盘）。
//    - 可注入：executor / decomposer / routeEngine 全部可注入便于测试；shadowMode 下不触碰真实 adapter。
//    - shadow 优先：默认 shadow——只跑调度逻辑产出决策/聚合/历史，不执行真实 adapter（避免非侵入 + 零副作用 demo）。
//
// 执行模型：
//   - 按拓扑序、ready 子任务（deps 全 done/skipped）并发执行；
//   - 条件分支：子任务 when(ctx) 返回 false → skipped，其依赖的下游在自身当 ctx 时若判 false 也 skip；
//   - 容错：失败 → 重试（retry 次）→ 仍失败走 fallback（备用子任务 id，其 when 默认 true）→ 仍失败则 failed；
//   - 聚合：全部子任务终态后，按序拼 report（JSON + Markdown）。

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RETRIES = 1;

class Orchestrator {
    constructor({ executor, routeEngine, decomposer, shadowMode = true, dir = null, maxRetries = DEFAULT_MAX_RETRIES, retriever = null } = {}) {
        this.executor = executor;          // 注入：(subtask, ctx, runOpts) => result；shadowMode 下不被调用
        this.routeEngine = routeEngine;    // 注入：非 shadow 时由 executor 用其 route() 选 adapter
        this.decomposer = decomposer;      // 注入：runFromInput 用；否则用内置 templateDecompose
        this.shadowMode = shadowMode;
        this.dir = dir;                    // 非侵入：null=仅内存；注入才落盘
        this.maxRetries = maxRetries;
        this.retriever = retriever;        // I1 RAG（拉模式）：第 5 可注入项；null=不检索、不挂 ctx.knowledge（零回归）
        this.history = [];                 // 协作历史（任务级）
        this._seq = 0;
     }

    // 便捷：从原始输入拆解 + 执行
    async runFromInput(input, opts = {}) {
        const decomposeFn = this.decomposer || require('./decomposer.js').decompose;
        const dag = await decomposeFn(input, { ...opts, input });
        return this.run(dag, opts);
    }

    // 跑一个已解析的 DAG，返回 { results, report, history }
    async run(dag, opts = {}) {
       const subtasks = dag.subtasks;
       const byId = new Map(subtasks.map((s) => [s.id, s]));
        // 前置：拒绝环
       const { hasCycle } = require('./decomposer.js');
       if (hasCycle(dag)) throw new Error('orchestrator: DAG has cycle, refusing to schedule');

       const results = {}; // id -> { id, status, value?, attempts?, skipped?, fallbackFrom? }
       const executionOrder = [];
       const runId = `run_${Date.now()}_${(this._seq += 1)}`;

       const ctx = { results, dag, runId, ...((opts.ctx) || {}) };

        // 调度：每轮挑「deps 全到终态且自身未处理」的 ready 子任务并发执行；
       // 用 processed/total 驱动终止（不用 remaining.delete——ready 元素是子任务对象非 id，易错）。
       const total = subtasks.length;
       let processed = 0;
       let guard = 0;
       while (processed < total) {
           if (++guard > total * total + total + 1) throw new Error('orchestrator: scheduling did not converge');
           const ready = this._computeReady(subtasks, results);
           if (ready.length === 0) {
             // 仍有未处理却无 ready → 真死锁/不可满足：标 blocked（不谎报全 done）
               for (const s of subtasks) if (!results[s.id]) results[s.id] = { id: s.id, status: 'blocked' };
               processed = total;
               break;
            }
           await Promise.all(ready.map((st) => this._executeSubtask(st, byId, results, ctx, executionOrder)));
           processed += ready.length;
        }

        const report = this._aggregate(subtasks, results, { runId, shadowMode: this.shadowMode, input: dag.input });
        const historyEntry = {
            runId,
            ts: new Date().toISOString(),
            input: dag.input || (opts.input && String(opts.input).slice(0, 80)) || null,
            template: dag.template || null,
            subtasks: subtasks.map((s) => ({ id: s.id, type: s.type, status: results[s.id] ? results[s.id].status : 'missing' })),
            shadowMode: this.shadowMode,
         };
        this.history.push(historyEntry);
        this._persistHistory(historyEntry);

        return { results, report, history: historyEntry };
    }

    getHistory() { return this.history; }
    setShadowMode(on) { this.shadowMode = on; }

    // ---- 私有 ----

    // ready：deps 全部已到达终态（done/skipped/failed/fallback-done）的子任务
    _computeReady(subtasks, results) {
        return subtasks.filter((s) => {
            if (results[s.id]) return false;                // 已处理
            return s.deps.every((d) => results[d] && results[d].status !== 'running');
        });
    }

    async _executeSubtask(st, byId, results, ctx, executionOrder) {
        // 条件分支：when(ctx) 为 false → 跳过
        if (typeof st.when === 'function') {
            let keep = true;
            try { keep = !!st.when(ctx); } catch { keep = true; }
            if (!keep) {
                results[st.id] = { id: st.id, status: 'skipped', reason: 'when' };
                executionOrder.push(st.id);
                return;
            }
        }
        // 依赖被跳过/失败 → 本任务无前置可执行，跳过
        if (st.deps.some((d) => results[d] && (results[d].status === 'skipped' || results[d].status === 'failed'))) {
            results[st.id] = { id: st.id, status: 'skipped', reason: 'dep-unmet' };
            executionOrder.push(st.id);
            return;
         }

        // I1 RAG（拉模式）：仅当 retriever 注入 + 子任务声明 useKnowledge!==false → 检索挂 ctx.knowledge。
        // 默认 useKnowledge 视为 false（不检索、不注入，与「永不自动注入」一致）；shadowMode 下不检索（与 shadow 零回归一致）。
        if (this.retriever && st.useKnowledge !== false && st.knowledgeQuery !== undefined && !this.shadowMode) {
            try {
                ctx.knowledge = await this.retriever.retrieve({
                    query: st.knowledgeQuery || st.prompt || dag.input,
                    topK: st.knowledgeTopK || 3,
                });
            } catch (e) {
                ctx.knowledge = null; // 非侵入：检索失败不阻断调度
            }
        }

        // 重试 + 执行
        const maxTries = (st.retry != null ? st.retry : this.maxRetries) + 1;
        let lastErr = null;
        let attempts = 0;
        for (let i = 0; i < maxTries; i++) {
            attempts++;
            try {
                const value = this.shadowMode
                    ? { shadow: true, subtaskId: st.id, routedVia: this.routeEngine ? 'routeEngine' : null }
                    : await this._invoke(st, ctx);
                results[st.id] = { id: st.id, status: 'done', value, attempts };
                executionOrder.push(st.id);
                return;
            } catch (e) {
                lastErr = e;
            }
        }

        // fallback：备用子任务
        if (st.fallback && byId.has(st.fallback)) {
            const fb = byId.get(st.fallback);
            try {
                const value = this.shadowMode
                    ? { shadow: true, subtaskId: fb.id, viaFallback: st.fallback }
                    : await this._invoke(fb, ctx);
                results[st.id] = { id: st.id, status: 'done', value, attempts, fallbackFrom: st.id, via: fb.id };
                executionOrder.push(fb.id);
                return;
            } catch (e2) {
                lastErr = e2 || lastErr;
            }
        }

        results[st.id] = { id: st.id, status: 'failed', attempts, error: String(lastErr && lastErr.message || lastErr) };
        executionOrder.push(st.id);
    }

    async _invoke(st, ctx) {
        if (typeof this.executor !== 'function') throw new Error('orchestrator: no executor injected (non-shadow)');
        // 非 shadow：经 executor 执行（executor 内部可用 this.routeEngine 选 adapter，但 adapter 调用是 executor 自己的事）
        return this.executor(st, ctx);
    }

    _aggregate(subtasks, results, meta) {
        const order = subtasks.map((s) => s.id);
        const json = {
            runId: meta.runId,
            shadowMode: meta.shadowMode,
            input: meta.input,
            summary: order.reduce((acc, id) => Object.assign(acc, { [id]: results[id] ? results[id].status : 'missing' }), {}),
            subtasks: order.map((id) => results[id] || { id, status: 'missing' }),
        };
        const md = this._toMarkdown(json);
        return { json, markdown: md };
    }

    _toMarkdown(r) {
        const lines = [`# 编排结果 ${r.runId}${r.shadowMode ? '（shadow 模式）' : ''}`];
        if (r.input) lines.push('', `**输入**：${r.input}`);
        lines.push('');
        for (const s of r.subtasks) {
            const tag = s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏭️' : s.status === 'failed' ? '❌' : '·';
            let v = '';
            if (s.value) v = typeof s.value === 'string' ? ` → ${s.value.slice(0, 40)}` : ' → ' + JSON.stringify(s.value).slice(0, 40);
            const fb = s.via ? ` (via ${s.via})` : '';
            lines.push(`- ${tag} ${s.id}${fb}${v}`);
        }
        return lines.join('\n');
    }

    _persistHistory(entry) {
        if (!this.dir) return;                       // 非侵入：未注入 dir 仅内存
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const file = path.join(this.dir, 'orchestration-history.json');
            let prev = [];
            try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = []; }
            prev.push(entry);
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(prev, null, 2));
            fs.renameSync(tmp, file);                 // 原子写
        } catch { /* 落盘失败不影响主流程 */ }
    }
}

module.exports = { Orchestrator, DEFAULT_MAX_RETRIES };
