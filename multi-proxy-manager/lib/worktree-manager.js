'use strict';

// Worktree Manager — M7 方向六 P1：git worktree 隔离原语（Orca 范式）
//
// 目标：把 multi-proxy 从「单 checkout 串行切模型」升级为「每任务一个 worktree 并行」的最小原语。
// 非侵入：纯库 + child_process spawn git，零新依赖；不碰 SessionStore/routes 生产路径。
//
// 安全纪律：
//   - worktree 只落在 baseDir（默认 ~/.multi-proxy-manager/worktrees）下，绝不在项目 repo 内建。
//   - sessionId/branch/baseRef 做字符白名单，防路径/引用注入。
//   - remove 只处理本管理器建的 worktree；永远不动 main checkout。
//   - prune 只清 git 自身残留元数据（git worktree prune）。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_DIR = path.join(process.env.HOME || '', '.multi-proxy-manager', 'worktrees');
const ID_RE = /^[a-zA-Z0-9_-]+$/;      // sessionId
const REF_RE = /^[a-zA-Z0-9._/-]+$/;    // branch / baseRef（git 引用合法字符）

function runGit(args, { cwd, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        });
    });
}

class WorktreeManager {
    constructor({ baseDir = DEFAULT_BASE_DIR } = {}) {
        this.baseDir = baseDir;
    }

    _wtPath(sessionId) {
        if (!ID_RE.test(sessionId)) throw new Error(`invalid sessionId: ${sessionId}`);
        return path.join(this.baseDir, sessionId);
    }

    // 为 session 建 worktree：git worktree add <baseDir>/<sessionId> -b <branch> <baseRef>
    // repoPath 必须是合法 git 仓库；baseRef 默认 HEAD（从当前分支切出）
    async createForSession({ sessionId, repoPath, baseRef = 'HEAD', branch = `m7-${sessionId}` }) {
        if (!REF_RE.test(branch)) throw new Error(`invalid branch: ${branch}`);
        if (!REF_RE.test(baseRef)) throw new Error(`invalid baseRef: ${baseRef}`);
        const wt = this._wtPath(sessionId);
        if (fs.existsSync(wt)) throw new Error(`worktree already exists: ${sessionId}`);
        fs.mkdirSync(this.baseDir, { recursive: true });
        await runGit(['worktree', 'add', wt, '-b', branch, baseRef], { cwd: repoPath });
        return { sessionId, path: wt, branch };
    }

    async exists(sessionId) {
        return fs.existsSync(this._wtPath(sessionId));
    }

    // 移除：git worktree remove（--force 允许有未提交改动时强删，调用方自负）
    // 绝不影响 main checkout（worktree remove 只移除指定目录）。
    async remove({ sessionId, repoPath, force = false }) {
        const wt = this._wtPath(sessionId);
        const args = ['worktree', 'remove', wt];
        if (force) args.push('--force');
        try {
            await runGit(args, { cwd: repoPath });
        } catch (e) {
            // 目录已不存在（手工删过）：清 git 元数据即可
            if (fs.existsSync(wt)) throw e;
            await runGit(['worktree', 'prune'], { cwd: repoPath });
        }
        return true;
    }

    // 清 git 自身残留元数据（worktree 目录被外力删掉后 git 会留 stale 记录）
    async prune(repoPath) {
        await runGit(['worktree', 'prune'], { cwd: repoPath });
        return true;
    }

    // 列出 baseDir 下现存 worktree 目录名（非 git 视角，纯文件系统）
    list() {
        if (!fs.existsSync(this.baseDir)) return [];
        return fs.readdirSync(this.baseDir).filter((n) => {
            try {
                return fs.statSync(path.join(this.baseDir, n)).isDirectory();
            } catch {
                return false;
            }
        });
    }
}

module.exports = { WorktreeManager, DEFAULT_BASE_DIR, runGit };
