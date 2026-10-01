'use strict';

// 宿主 adapter（P3 · 对照 SkillSwitch 后补的「宿主维」，见 docs/10-initiatives/48）
// l2/skill-service.js 的 adapter 只有「格式维」（json / yaml-text / view），不知道一条 skill
// 该落到哪个 agent 的哪个目录。本模块补的就是这张宿主表 + 读写落点。
//
// 非侵入④（铁律，别破）：
//   - 读（scan / detect / planInstall）可默认 os.homedir()，零副作用。
//   - 写（install / setEnabled）**绝不默认写 home**：必须显式传 home 或 project，否则抛错。
//     内核绝不主动碰 ~/.codex / ~/.hermes / ~/.cursor 等 agent 自身目录。
//
// 诚实边界（已实测，2026-10-01）：
//   - hermes 用「分类目录嵌套」：~/.hermes/skills/<category>/<name>/SKILL.md，
//     所以扫描必须下探一层，否则只能看到 26 个顶层 skill、漏掉分类里的。
//   - cursor 本机 superpowers-zh 是**平铺 md**、没有 SKILL.md → 报 kind='loose-md' 而不是假装 0 个。
//   - 禁用约定 `.disabled` 后缀抄自 whale2002/skills-switch，**未在各宿主上逐个验证生效**，
//     标记为 unverified，别对外当既成事实讲。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { estimateTokens } = require('./token-policy.js');   // 复用不重造（AGENTS §3 红线）

// SkillSwitch（DargonLee/skill-switch）覆盖 claude/codex/gemini/cursor/windsurf；
// hermes + workbuddy 是本机真正的两堆，也是它认不到的差异化位。
const HOSTS = {
    hermes: { id: 'hermes', label: 'Hermes Agent', globalDir: '.hermes/skills',
        projectDir: '.hermes/skills', entry: 'SKILL.md', skillSwitch: false },
    workbuddy: { id: 'workbuddy', label: 'WorkBuddy', globalDir: '.workbuddy/skills',
        projectDir: '.workbuddy/skills', entry: 'SKILL.md', skillSwitch: false },
    claude: { id: 'claude', label: 'Claude Code', globalDir: '.claude/skills',
        projectDir: '.claude/skills', entry: 'SKILL.md', skillSwitch: true },
    codex: { id: 'codex', label: 'Codex CLI', globalDir: '.codex/skills',
        projectDir: '.codex/skills', entry: 'SKILL.md', skillSwitch: true },
    cursor: { id: 'cursor', label: 'Cursor', globalDir: '.cursor/skills',
        projectDir: '.cursor/skills', entry: 'SKILL.md', skillSwitch: true },
    gemini: { id: 'gemini', label: 'Gemini CLI', globalDir: '.gemini/skills',
        projectDir: '.gemini/skills', entry: 'SKILL.md', skillSwitch: true },
    windsurf: { id: 'windsurf', label: 'Windsurf', globalDir: '.windsurf/skills',
        projectDir: '.windsurf/skills', entry: 'SKILL.md', skillSwitch: true },
};

const DISABLE_SUFFIX = '.disabled';

function listHosts() {
    return Object.values(HOSTS).map((h) => ({ ...h }));
}
function getHost(hostId) {
    const h = HOSTS[hostId];
    if (!h) { throw new Error(`unknown host: ${hostId} (known: ${Object.keys(HOSTS).join(',')})`); }
    return h;
}

// 解析某宿主在某作用域下的 skills 目录（纯计算，不建目录、不读盘）
function resolveDir(hostId, opts = {}) {
    const h = getHost(hostId);
    if (opts.project) { return path.join(opts.project, h.projectDir); }
    return path.join(opts.home || os.homedir(), h.globalDir);
}

// 单个候选目录的分类：有 entry 文件 = 标准 skill；只有 md = 平铺；都不是 = 跳过
function classify(dir, name, entry) {
    const entryFile = path.join(dir, entry);
    if (fs.existsSync(entryFile)) {
        return { name, path: dir, entry: entryFile, kind: 'skill' };
    }
    const inner = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (inner.length) {
        return { name, path: dir, entry: null, kind: 'loose-md', mdFiles: inner.length };
    }
    return null;
}

// SKILL.md → 规范字段（去 frontmatter，供 measureSkillTokens 复用同一口径）
// 本机两种形态都遇到过：claude/codex 有 `name:`/`description:`；cursor 的平铺 md 可能一个都没有。
function readSkillMd(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { name: '', description: '', content: raw };
    const fm = m[1];
    const nm = fm.match(/^name:\s*(.+?)\s*$/m);
    const de = fm.match(/^description:\s*(.+?)\s*$/m);
    return {
        name: nm ? nm[1].replace(/^["']|["']$/g, '') : '',
        description: de ? de[1].replace(/^["']|["']$/g, '') : '',
        content: raw.slice(m[0].length),
    };
}

// 扫描某宿主已装的 skill（只读，零副作用）。
// opts.tokens=true 时给每条带 estTokens —— **默认不开**（126 条要读一次文件，别让 scan 变重）。
function scan(hostId, opts = {}) {
    const h = getHost(hostId);
    const root = resolveDir(hostId, opts);
    if (!fs.existsSync(root)) { return { host: hostId, dir: root, exists: false, skills: [] }; }
    const wantTokens = opts.tokens === true;
    const out = [];
    for (const name of fs.readdirSync(root)) {
        if (name.startsWith('.')) { continue; }                 // 隐藏项（.archive/.DS_Store）不算
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) { continue; }      // 散文件（zip/json）不算
        const hit = classify(dir, name, h.entry);
        if (hit) {
            out.push({ ...hit, host: hostId, scope: opts.project ? 'project' : 'global',
                disabled: name.endsWith(DISABLE_SUFFIX),
                ...(wantTokens ? tokenize(hit) : {}) });
            continue;
        }
        for (const sub of fs.readdirSync(dir)) {                 // 分类目录下探一层
            if (sub.startsWith('.')) { continue; }
            const subDir = path.join(dir, sub);
            if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) { continue; }
            const subHit = classify(subDir, sub, h.entry);
            if (subHit) {
                out.push({ ...subHit, host: hostId, scope: opts.project ? 'project' : 'global',
                    category: name, disabled: sub.endsWith(DISABLE_SUFFIX),
                    ...(wantTokens ? tokenize(subHit) : {}) });
            }
        }
    }
    return { host: hostId, dir: root, exists: true,
        ...(wantTokens ? { tokens: out.reduce((s, x) => s + (x.estTokens || 0), 0) } : {}),
        skills: out };
}

// 量一条磁盘上真实存在的 SKILL.md —— 直接量**它的全文**（frontmatter 也在内），
// 这才是 agent 真正读进去的那份；和 measureSkillTokens 量的「规范条目 toSkillMd 后的文本」是
// 两个口径，别混：measure 管"我们要装什么"，scan tokens 管"宿主里已经躺着什么"。
function tokenize(hit) {
    if (!hit.entry) { return { estTokens: null }; }              // 平铺 md 没有单体入口，量不了
    try {
        return { estTokens: estimateTokens(fs.readFileSync(hit.entry, 'utf8')) };
    } catch (e) {
        return { estTokens: null, tokenError: e.message };
    }
}

// 全量扫描所有宿主 + token 汇总（给 tools/skill-ledger.js 与 UI 用；只读）
function scanLedger(opts = {}) {
    const hosts = opts.hosts ? opts.hosts.map(getHost) : Object.values(HOSTS);
    const entries = [];
    const byHost = [];
    for (const h of hosts) {
        const r = scan(h.id, { ...opts, tokens: true });
        const row = {
            host: h.id,
            label: h.label,
            exists: r.exists,
            dir: r.dir,
            skillSwitch: h.skillSwitch,
            total: r.skills.length,
            standard: r.skills.filter((s) => s.kind === 'skill').length,
            nested: r.skills.filter((s) => s.category).length,
            looseMd: r.skills.filter((s) => s.kind === 'loose-md').length,
            disabled: r.skills.filter((s) => s.disabled).length,
            tokens: r.tokens || 0,
            measured: r.skills.filter((s) => s.estTokens != null).length,
        };
        byHost.push(row);
        entries.push(...r.skills.map((s) => ({ ...s, skillSwitch: h.skillSwitch })));
    }
    const shaped = entries.filter((s) => s.estTokens != null);
    return {
        generatedAt: new Date().toISOString(),
        hosts: byHost,
        totals: {
            entries: entries.length,
            measured: shaped.length,
            skipped: entries.length - shaped.length,
            tokens: shaped.reduce((s, x) => s + x.estTokens, 0),
        },
        entries,
    };
}

// 只回答「装下去会写什么」，不写任何东西（对齐 OpenShell prover 的 dry-run 思路）
function planInstall(skill, hostId, opts = {}) {
    const h = getHost(hostId);
    const dir = path.join(resolveDir(hostId, opts), skill.name);
    const entryFile = path.join(dir, h.entry);
    return {
        host: hostId,
        scope: opts.project ? 'project' : 'global',
        dir,
        entryFile,
        exists: fs.existsSync(dir),
        wouldOverwrite: fs.existsSync(entryFile),
        files: [h.entry],
    };
}

// 真写。必须显式传 home 或 project —— 内核绝不默认写 home（非侵入④）。
function install(skill, hostId, opts = {}) {
    if (!opts.home && !opts.project) {
        throw new Error('install: must pass explicit {home} or {project} (never defaults to home)');
    }
    const plan = planInstall(skill, hostId, opts);
    fs.mkdirSync(plan.dir, { recursive: true });
    fs.writeFileSync(plan.entryFile, toSkillMd(skill), 'utf8');
    return { ...plan, written: true };
}

// 规范条目 → SKILL.md（YAML frontmatter 是 Claude Code 的既有约定，其余宿主同理可读）
function toSkillMd(skill) {
    const desc = skill.description || skill.trigger || '';
    return `---\nname: ${skill.name}\ndescription: ${desc}\n---\n\n# ${skill.name}\n\n${skill.content || ''}\n`;
}

// 一条 skill 每轮占多少 token：量的是**真会写进宿主的那份 SKILL.md 文本**（与 install 同源，
// 避免"量的和装的不是一份"）。估算器复用 token-policy.estimateTokens，不重造。
// ⚠️ 这是估算口径（长度/3），不是真实 tokenizer、不是 provider usage，对外引用必须标注。
function measureSkillTokens(skill) {
    return estimateTokens(toSkillMd(skill));
}

// 启/禁用：`.disabled` 后缀（抄自 whale2002/skills-switch；**未逐宿主验证生效**）
function setEnabled(hostId, name, enabled, opts = {}) {
    if (!opts.home && !opts.project) {
        throw new Error('setEnabled: must pass explicit {home} or {project} (never defaults to home)');
    }
    const root = resolveDir(hostId, opts);
    const from = path.join(root, enabled ? name + DISABLE_SUFFIX : name);
    const to = path.join(root, enabled ? name : name + DISABLE_SUFFIX);
    if (!fs.existsSync(from)) { return { ok: false, reason: 'not-found', from, to }; }
    fs.renameSync(from, to);
    return { ok: true, from, to, unverified: true };
}

module.exports = {
    HOSTS, DISABLE_SUFFIX,
    listHosts, getHost, resolveDir, scan, scanLedger, planInstall, install, setEnabled,
    toSkillMd, readSkillMd, measureSkillTokens,
};
