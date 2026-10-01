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

// 扫描某宿主已装的 skill（只读，零副作用）。
// depth=2 是为了 hermes 的「分类目录」：顶层无 SKILL.md 时下探一层。
function scan(hostId, opts = {}) {
    const h = getHost(hostId);
    const root = resolveDir(hostId, opts);
    if (!fs.existsSync(root)) { return { host: hostId, dir: root, exists: false, skills: [] }; }
    const out = [];
    for (const name of fs.readdirSync(root)) {
        if (name.startsWith('.')) { continue; }                 // 隐藏项（.archive/.DS_Store）不算
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) { continue; }      // 散文件（zip/json）不算
        const hit = classify(dir, name, h.entry);
        if (hit) {
            out.push({ ...hit, scope: opts.project ? 'project' : 'global',
                disabled: name.endsWith(DISABLE_SUFFIX) });
            continue;
        }
        for (const sub of fs.readdirSync(dir)) {                 // 分类目录下探一层
            if (sub.startsWith('.')) { continue; }
            const subDir = path.join(dir, sub);
            if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) { continue; }
            const subHit = classify(subDir, sub, h.entry);
            if (subHit) {
                out.push({ ...subHit, scope: opts.project ? 'project' : 'global',
                    category: name, disabled: sub.endsWith(DISABLE_SUFFIX) });
            }
        }
    }
    return { host: hostId, dir: root, exists: true, skills: out };
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
    listHosts, getHost, resolveDir, scan, planInstall, install, setEnabled, toSkillMd,
    measureSkillTokens,
};
