'use strict';

// Session Store — M7 任务级 Session 存储
// 职责：跨轮次保存任务状态，支持崩溃恢复和手动干预。
//
// 数据格式（sessions.json）：
//   { specVersion: '1.0.0', sessions: [
//     {
//       sessionId, proxy, targetProvider, targetAdapter,
//       createdAt, updatedAt, status: 'running'|'done'|'failed'|'aborted',
//       task: { type, prompt, meta: {} },
//       steps: [{ step, tool, input, output, status, checkpoint, timestamp }],
//       checkpoint: { ... }, // 最新检查点快照
//       abortedBy: null|'user'|'crash'
//     }
//   ]}
//
// 工程纪律：
//   - Session 持久 ≠ 工作目录永久：状态落盘 sessions.json，不依赖内存。
//   - 恢复 ≠ 命令自动续跑：重连只读回状态，副作用动作需幂等 + checkpoint + 补偿。
//   - 原子写：.tmp → rename（参考 providers.json P1 经验）。

const fs = require('fs');
const path = require('path');

const SPEC_VERSION = '1.0.0';
const SESSION_STATUSES = ['running', 'done', 'failed', 'aborted'];
const STEP_STATUSES = ['pending', 'running', 'done', 'failed'];
const DEFAULT_DIR = path.join(process.env.HOME || '', '.multi-proxy-manager');
const FILENAME = 'sessions.json';

function validateSession(s) {
    const errs = [];
    if (!s || typeof s !== 'object') errs.push('session not object');
    if (!s.sessionId || typeof s.sessionId !== 'string') errs.push('missing sessionId');
    if (!s.proxy || typeof s.proxy !== 'string') errs.push('missing proxy');
    if (!s.status || !SESSION_STATUSES.includes(s.status)) errs.push(`invalid status: ${s.status}`);
    if (!s.task || typeof s.task !== 'object') errs.push('missing task');
    if (!s.steps || !Array.isArray(s.steps)) errs.push('steps not array');
    for (const step of s.steps) {
        if (!step.step || typeof step.step !== 'number') errs.push('step missing/invalid');
        if (!step.tool || typeof step.tool !== 'string') errs.push('step missing tool');
        if (!step.status || !STEP_STATUSES.includes(step.status)) errs.push(`step invalid status: ${step.status}`);
        if (!step.timestamp || typeof step.timestamp !== 'string') errs.push('step missing timestamp');
    }
    return errs.length ? errs : null;
}

class SessionStore {
    constructor({ dir = DEFAULT_DIR } = {}) {
        this.dir = dir;
        this.file = path.join(dir, FILENAME);
        this.sessions = new Map();
        this._load();
    }

    _load() {
        if (!fs.existsSync(this.file)) return;
        try {
            const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const entries = Array.isArray(doc.sessions) ? doc.sessions : [];
            for (const s of entries) {
                if (s && s.sessionId) this.sessions.set(s.sessionId, s);
            }
        } catch (e) {
            // 损坏文件：保留内存状态，下次启动重建
        }
    }

    _save() {
        // 确保目录存在（与 logger/health/error-patterns 一致；
        // 干净 HOME 下 ~/.multi-proxy-manager 可能尚未创建，否则会 ENOENT 崩）
        try {
            if (!fs.existsSync(this.dir)) {
               fs.mkdirSync(this.dir, { recursive: true });
             }
        } catch { /* best-effort */ }
        const tmp = this.file + '.tmp';
        const doc = { specVersion: SPEC_VERSION, sessions: [...this.sessions.values()] };
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, this.file);
      }

    create(session) {
        const id = session.sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const full = {
            sessionId: id,
            proxy: session.proxy,
            targetProvider: session.targetProvider || null,
            targetAdapter: session.targetAdapter || null,
            createdAt: now,
            updatedAt: now,
            status: session.status || 'running',
            task: session.task,
            steps: session.steps || [],
            checkpoint: session.checkpoint || null,
            abortedBy: null,
        };
        const errs = validateSession(full);
        if (errs) throw new Error(`invalid session: ${errs.join('; ')}`);
        this.sessions.set(id, full);
        this._save();
        return full;
    }

    update(sessionId, patch) {
        const cur = this.get(sessionId);
        const merged = { ...cur, ...patch, sessionId, updatedAt: new Date().toISOString() };
        const errs = validateSession(merged);
        if (errs) throw new Error(`invalid session update: ${errs.join('; ')}`);
        this.sessions.set(sessionId, merged);
        this._save();
        return merged;
    }

    addStep(sessionId, step) {
        const cur = this.get(sessionId);
        const now = new Date().toISOString();
        const stepEntry = {
            step: step.step,
            tool: step.tool,
            input: step.input || null,
            output: step.output || null,
            status: step.status || 'pending',
            checkpoint: step.checkpoint || null,
            timestamp: now,
        };
        const steps = [...cur.steps, stepEntry];
        const updated = this.update(sessionId, {
            steps,
            checkpoint: step.checkpoint || cur.checkpoint,
            status: step.status === 'failed' ? 'failed' : cur.status,
        });
        return updated;
    }

    abort(sessionId, by = 'user') {
        const cur = this.get(sessionId);
        return this.update(sessionId, {
            status: 'aborted',
            abortedBy: by,
            updatedAt: new Date().toISOString(),
        });
    }

    markDone(sessionId) {
        const cur = this.get(sessionId);
        return this.update(sessionId, { status: 'done' });
    }

    markFailed(sessionId, error) {
        const cur = this.get(sessionId);
        return this.update(sessionId, {
            status: 'failed',
            error: error?.message || String(error),
        });
    }

    get(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error(`session not found: ${sessionId}`);
        return s;
    }

    list(filter = {}) {
        let result = [...this.sessions.values()];
        if (filter.proxy) result = result.filter(s => s.proxy === filter.proxy);
        if (filter.status) result = result.filter(s => s.status === filter.status);
        if (filter.limit) result = result.slice(0, filter.limit);
        return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    remove(sessionId) {
        if (!this.sessions.has(sessionId)) throw new Error(`session not found: ${sessionId}`);
        this.sessions.delete(sessionId);
        this._save();
        return true;
    }

    count() {
        return this.sessions.size;
    }

    // 恢复：列出所有 running 状态的 session（proxy 崩溃后查询）
    getRunning() {
        return this.list({ status: 'running' });
    }
}

module.exports = { SessionStore, validateSession, SPEC_VERSION };
