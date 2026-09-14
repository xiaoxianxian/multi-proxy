'use strict';

// jest test for WorktreeManager（M7 方向六 P1：git worktree 隔离原语）
// 真 git 仓库往返验证：init 一个 tmp repo，worktree add/remove/prune 全流程实测。
const { WorktreeManager, runGit } = require('../../../multi-proxy-manager/lib/worktree-manager');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    await runGit(['init', '-q'], { cwd: dir });
    await runGit(['config', 'user.email', 'm7@test.local'], { cwd: dir });
    await runGit(['config', 'user.name', 'M7 Test'], { cwd: dir });
    await runGit(['add', 'a.txt'], { cwd: dir });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('WorktreeManager', () => {
    let repo;
    let baseDir;
    let mgr;

    beforeEach(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mgr-'));
        repo = path.join(tmp, 'repo');
        baseDir = path.join(tmp, 'wts');
        await initRepo(repo);
        mgr = new WorktreeManager({ baseDir });
    });

    test('createForSession: 每任务一个 worktree + 独立分支', async () => {
        const r = await mgr.createForSession({ sessionId: 's-001', repoPath: repo });
        expect(r.sessionId).toBe('s-001');
        expect(r.branch).toBe('m7-s-001');
        expect(fs.existsSync(r.path)).toBe(true);
        expect(fs.readFileSync(path.join(r.path, 'a.txt'), 'utf8')).toBe('v1\n');
        // 分支确实建了
        const { stdout } = await runGit(['branch', '--list', 'm7-s-001'], { cwd: repo });
        // 被 worktree 检出的分支输出带 "+ " 前缀
        expect(stdout.trim().replace(/^\+\s*/, '')).toBe('m7-s-001');
    });

    test('worktree 内提交不影响 main checkout（隔离性）', async () => {
        const r = await mgr.createForSession({ sessionId: 's-002', repoPath: repo });
        fs.writeFileSync(path.join(r.path, 'a.txt'), 'v2-in-worktree\n');
        await runGit(['add', 'a.txt'], { cwd: r.path });
        await runGit(['commit', '-q', '-m', 'w2'], { cwd: r.path });
        // main 分支内容不变
        expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('v1\n');
    });

    test('重复 create 同 sessionId 报错（不覆盖）', async () => {
        await mgr.createForSession({ sessionId: 's-003', repoPath: repo });
        await expect(mgr.createForSession({ sessionId: 's-003', repoPath: repo }))
            .rejects.toThrow(/already exists/);
    });

    test('指定 baseRef 从既有分支切出', async () => {
        // main 上先建一个 dev 分支
        await runGit(['branch', 'dev'], { cwd: repo });
        const r = await mgr.createForSession({ sessionId: 's-004', repoPath: repo, baseRef: 'dev', branch: 'm7-s-004' });
        expect(r.branch).toBe('m7-s-004');
        const { stdout } = await runGit(['branch', '--contains', 'm7-s-004'], { cwd: repo });
        expect(stdout).toContain('dev');
    });

    test('remove: worktree 目录消失，main checkout 完好', async () => {
        const r = await mgr.createForSession({ sessionId: 's-005', repoPath: repo });
        await mgr.remove({ sessionId: 's-005', repoPath: repo });
        expect(fs.existsSync(r.path)).toBe(false);
        expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('v1\n');
    });

    test('remove 已外力删除的 worktree：不抛错，顺带 prune', async () => {
        const r = await mgr.createForSession({ sessionId: 's-006', repoPath: repo });
        fs.rmSync(r.path, { recursive: true, force: true }); // 模拟外力删
        await expect(mgr.remove({ sessionId: 's-006', repoPath: repo })).resolves.toBe(true);
    });

    test('list: 返回 baseDir 下现存 worktree', async () => {
        await mgr.createForSession({ sessionId: 'wt-a', repoPath: repo });
        await mgr.createForSession({ sessionId: 'wt-b', repoPath: repo });
        expect(mgr.list().sort()).toEqual(['wt-a', 'wt-b']);
        await mgr.remove({ sessionId: 'wt-a', repoPath: repo });
        expect(mgr.list()).toEqual(['wt-b']);
    });

    test('sessionId 路径注入被拒', async () => {
        await expect(mgr.createForSession({ sessionId: '../../etc', repoPath: repo }))
            .rejects.toThrow(/invalid sessionId/);
        await expect(mgr.createForSession({ sessionId: 'a/b', repoPath: repo }))
            .rejects.toThrow(/invalid sessionId/);
    });

    test('branch 非法字符被拒', async () => {
        await expect(mgr.createForSession({ sessionId: 's-007', repoPath: repo, branch: 'bad name' }))
            .rejects.toThrow(/invalid branch/);
        await expect(mgr.createForSession({ sessionId: 's-008', repoPath: repo, baseRef: 'HEAD;rm' }))
            .rejects.toThrow(/invalid baseRef/);
    });

    test('create 在非法目录上 fail fast', async () => {
        const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-notrepo-'));
        await expect(mgr.createForSession({ sessionId: 's-009', repoPath: notRepo }))
            .rejects.toThrow(/failed/);
    });
});
