/**
 * skill-hosts 路由单测（L2 P3 · 宿主 adapter 只读面）
 *
 * 覆盖：
 *   ① 门控默认关 → 403 零副作用（三个端点）
 *   ② 门控开 → 宿主表 / scan / plan 行为
 *   ③ **只读铁律**：scan 与 plan 都不写任何文件（含真实 home 也不碰）
 *
 * 扫描断言用临时 project 目录造 fixture，不依赖本机真实 home（避免环境耦合）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const ROUTE = require('../../routes/skill-hosts');

const app = express();
app.use(express.json());
app.use('/api/skill-hosts', ROUTE);

// 临时 project fixture：hermes 宿主（分类目录嵌套 + 平铺 md + 隐藏项 + 散文件）
let proj = null;
function buildFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-route-'));
    const skills = path.join(root, '.hermes', 'skills');
    fs.mkdirSync(path.join(skills, 'devops', 'nested-one'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'devops', 'nested-one', 'SKILL.md'), '# nested-one\n', 'utf8');
    fs.mkdirSync(path.join(skills, 'flat-md'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'flat-md', 'README.md'), 'no entry here\n', 'utf8');
    fs.mkdirSync(path.join(skills, 'top-one'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'top-one', 'SKILL.md'), '# top-one\n', 'utf8');
    fs.mkdirSync(path.join(skills, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(skills, '.hidden', 'SKILL.md'), '# hidden\n', 'utf8');
    fs.writeFileSync(path.join(skills, 'stray.json'), '{}', 'utf8');
    return root;
}
function countFiles(dir) {
    let n = 0;
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) { walk(path.join(d, e.name)); } else { n += 1; }
        }
    }(dir));
    return n;
}

describe('skill-hosts 路由（只读面）', () => {
    let before = 0;
    afterEach(() => { delete process.env.PROXY_L2_SKILLHOSTS; });

    beforeEach(() => {
        if (!proj) { proj = buildFixture(); }
        before = countFiles(proj);
    });
    afterAll(() => { if (proj) { fs.rmSync(proj, { recursive: true, force: true }); } });

    test('① 门控未开启 → 三个端点一律 403', async () => {
        const g = await request(app).get('/api/skill-hosts');
        expect(g.status).toBe(403);
        const s = await request(app).get('/api/skill-hosts/hermes/scan');
        expect(s.status).toBe(403);
        const p = await request(app).post('/api/skill-hosts/plan').send({ host: 'hermes', name: 'x' });
        expect(p.status).toBe(403);
    });

    test('② 门控开启 → GET / 返回全部宿主且带 skillSwitch 标记', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).get('/api/skill-hosts');
        expect(r.status).toBe(200);
        expect(r.body.length).toBe(7);
        const hermes = r.body.find((h) => h.id === 'hermes');
        expect(hermes.skillSwitch).toBe(false);
        expect(r.body.filter((h) => h.skillSwitch).length).toBe(5);
    });

    test('② scan：嵌套分类下探 + 平铺 md 单独归类 + 隐藏项与散文件不算', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).get(`/api/skill-hosts/hermes/scan?project=${encodeURIComponent(proj)}`);
        expect(r.status).toBe(200);
        const names = r.body.skills.map((s) => s.name).sort();
        expect(names).toEqual(['flat-md', 'nested-one', 'top-one']);
        const nested = r.body.skills.find((s) => s.name === 'nested-one');
        expect(nested.kind).toBe('skill');
        expect(nested.category).toBe('devops');
        const flat = r.body.skills.find((s) => s.name === 'flat-md');
        expect(flat.kind).toBe('loose-md');
        expect(r.body.skills.every((s) => s.scope === 'project')).toBe(true);
    });

    test('② scan 未知宿主 → 404', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).get('/api/skill-hosts/nope/scan');
        expect(r.status).toBe(404);
    });

    test('② scan 未安装宿主 → 404 + dir（不伪装成 0 个）', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).get('/api/skill-hosts/windsurf/scan');
        expect(r.status).toBe(404);
        expect(r.body.error).toBe('host-not-installed');
        expect(r.body.dir).toContain('.windsurf');
    });

    test('② plan：dry-run 只回答会写什么，不落盘', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).post('/api/skill-hosts/plan')
            .send({ host: 'hermes', name: 'planned-one', project: proj });
        expect(r.status).toBe(200);
        expect(r.body.dir).toBe(path.join(proj, '.hermes', 'skills', 'planned-one'));
        expect(r.body.entryFile).toBe(path.join(proj, '.hermes', 'skills', 'planned-one', 'SKILL.md'));
        expect(r.body.exists).toBe(false);
        expect(r.body.wouldOverwrite).toBe(false);
        expect(countFiles(proj)).toBe(before);
    });

    test('② plan 目标已存在 → wouldOverwrite=true 且依旧不写', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const body = { host: 'hermes', name: 'planned-one', project: proj };
        // 造出「已存在」状态：plan 自己不写，这一步必须绕过 HTTP 面直接建（模拟曾装过）
        fs.mkdirSync(path.join(proj, '.hermes', 'skills', 'planned-one'), { recursive: true });
        fs.writeFileSync(path.join(proj, '.hermes', 'skills', 'planned-one', 'SKILL.md'), 'old\n', 'utf8');
        const r = await request(app).post('/api/skill-hosts/plan').send(body);
        expect(r.body.exists).toBe(true);
        expect(r.body.wouldOverwrite).toBe(true);
        expect(countFiles(proj)).toBe(before + 1);   // 只多了我们手造的 1 个 SKILL.md（目录不计数），plan 没加量
    });

    test('② budget-plan：按预算裁掉最贵的，且一个字节都不写', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        // 造三条知道 token 量的 skill（估算口径 = 文本长度/3）
        const mk = (name, chars) => {
            fs.mkdirSync(path.join(proj, '.hermes', 'skills', name), { recursive: true });
            fs.writeFileSync(path.join(proj, '.hermes', 'skills', name, 'SKILL.md'), 'x'.repeat(chars), 'utf8');
        };
        // ⚠️ 长度按校准后的估算系数（ASCII ≈ 0.255 token/字符）反推：300→76 / 3000→765 / 40000→10200
        mk('cheap', 300); mk('mid', 3000); mk('fat', 40000);  // 76 / 765 / 10200 tok

        const r = await request(app).post('/api/skill-hosts/budget-plan')
            .send({ project: proj, budget: 1100 });
        expect(r.status).toBe(200);
        // cost DESC：fat(10000) 塞不下 → excluded（fixture 里原有的 nested-one/top-one 也一起被挤掉，
        // 所以只断言「fat 必在 excluded 且其 estTokens 就是造出来的量」，别把杂项算死）
        const fat = r.body.excluded.find((s) => s.name === 'fat');
        expect(fat).toBeTruthy();
        expect(fat.estTokens).toBe(10200);
        expect(r.body.injectedTokens).toBeLessThanOrEqual(1100);
        expect(r.body.excludedTokens).toBeGreaterThanOrEqual(10200);
        expect(r.body.netTokenDelta).toBe(-r.body.excludedTokens);
        expect(r.body.excluded.every((s) => s.estTokens != null)).toBe(true);
        // 装 + 关 = 候选总量（口径自洽）
        expect(r.body.injectedTokens + r.body.excludedTokens).toBe(r.body.candidatesTokens);

        // 纯算不落盘
        expect(countFiles(proj)).toBe(before + 3);

        // 预算放开 → 全装，excluded 空
        const wide = await request(app).post('/api/skill-hosts/budget-plan')
            .send({ project: proj, budget: 999999 });
        expect(wide.body.excludedTokens).toBe(0);
        // fixture 里原有条目也在（nested-one/top-one），所以只断言「我造的这 3 条全装进去」
        for (const n of ['cheap', 'mid', 'fat']) {
            expect(wide.body.injected.some((s) => s.name === n)).toBe(true);
        }
        expect(wide.body.injectedCount).toBeGreaterThanOrEqual(3);
        expect(countFiles(proj)).toBe(before + 3);
    });

    test('② budget-plan：host 过滤 + 未知宿主 404', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const r = await request(app).post('/api/skill-hosts/budget-plan')
            .send({ project: proj, host: 'hermes', budget: 999999 });
        expect(r.status).toBe(200);
        expect(r.body.candidates).toBeGreaterThan(0);
        expect(r.body.injectedTokens + r.body.excludedTokens).toBe(r.body.candidatesTokens);

        const bad = await request(app).post('/api/skill-hosts/budget-plan')
            .send({ host: 'nope' });
        expect(bad.status).toBe(404);
    });

    test('② budget-plan 门控未开 → 403', async () => {
        const r = await request(app).post('/api/skill-hosts/budget-plan').send({ budget: 1000 });
        expect(r.status).toBe(403);
    });

    test('② plan 缺 host / 缺 name → 400', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const a = await request(app).post('/api/skill-hosts/plan').send({ name: 'x' });
        expect(a.status).toBe(400);
        const b = await request(app).post('/api/skill-hosts/plan').send({ host: 'hermes' });
        expect(b.status).toBe(400);
    });

    // 注：scan 不支持（也不该支持）通过 HTTP 传 home —— 默认只扫调用者自己的 home，
    // 这是安全默认。所以这条断言「默认作用域 = global + 扫完真实目录零增改」。
    test('③ 只读铁律：默认扫 home、作用域 global、扫完真实目录零增改', async () => {
        process.env.PROXY_L2_SKILLHOSTS = '1';
        const skillsDir = path.join(os.homedir(), '.codex', 'skills');
        const snap = countFiles(skillsDir);
        const r = await request(app).get('/api/skill-hosts/codex/scan');
        expect(r.status).toBe(200);
        expect(r.body.dir).toBe(skillsDir);
        expect(r.body.skills.every((s) => s.scope === 'global')).toBe(true);
        // scan 结果与「自己再算一遍」必须完全一致（不钉死具体数字，避免耦合本机装了什么）
        const ground = fs.readdirSync(skillsDir)
            .filter((n) => { const d = path.join(skillsDir, n); return !n.startsWith('.') && fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'SKILL.md')); })
            .sort();
        expect(r.body.skills.map((s) => s.name).sort()).toEqual(ground);
        expect(countFiles(skillsDir)).toBe(snap);
    });
});
