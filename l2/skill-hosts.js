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

// 逐宿主验证（2026-10-01，证据以**本机源码**为准，file:line 可回源）：
//  - hermes：**后缀无效**。agent/skill_utils.py:22-26 的 EXCLUDED_SKILL_DIRS 是**精确名字集合**
//    （.git/.hub/.archive/.curator_backups/.locks/.venv/...），没有 .disabled；
//    agent/skill_utils.py:70-75 is_excluded_skill_path() 就是拿它逐段比对；
//    agent/prompt_builder.py:1221 `dirs[:] = [d for d in dirs if d not in EXCLUDED_SKILL_DIRS ...]`
//    → 叫 x.disabled 的目录照样被 os.walk 走进去，里面的 SKILL.md 照样被发现、照样进 system prompt。
//    hermes 的真禁用 = config.yaml 的 skills.disabled / skills.platform_disabled（**按 skill 名**）：
//    agent/skill_utils.py:298-310 get_disabled_skill_names()，生效点 agent/skill_utils.py:703
//    `if skill_name in disabled or not skill_matches_platform(frontmatter): continue`。
//  - 其余 6 个宿主（workbuddy/claude/codex/cursor/gemini/windsurf）：本机没有可查的加载源码
//    （workbuddy 只翻到打包后的 app.asar，里面 1122 处 .disabled 全在 admin/后台配置域，与技能加载无关）→ 存量 unverified。
const DISABLE_MECHANISM = {
    hermes: { strategy: 'native-config', configPath: '.hermes/config.yaml', verified: true,
        keys: ['skills.disabled'], files: ['agent/skill_utils.py:22-26,70-75,298-310,703', 'agent/prompt_builder.py:1221'] },
    workbuddy: { strategy: 'suffix', verified: false, reason: '本机只有打包 app.asar，无法定位技能加载逻辑' },
    claude: { strategy: 'suffix', verified: false, reason: '本机未装 Claude Code CLI，无源码可查' },
    codex: { strategy: 'suffix', verified: false, reason: '本机 codex 是 Node shim，未定位到技能发现代码' },
    cursor: { strategy: 'suffix', verified: false, reason: '本机只有 1 个平铺 md（loose-md），未见宿主源码' },
    gemini: { strategy: 'suffix', verified: false, reason: '本机未装 Gemini CLI' },
    windsurf: { strategy: 'suffix', verified: false, reason: '本机未装 Windsurf CLI' },
};

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
    // 「已禁用」要正常出现在账本里（名字去掉后缀、打 disabled 标记），否则用户没法追溯它去哪了。
    // ⚠️ 早先的版本用 `disabled: name.endsWith(DISABLE_SUFFIX)` 只打标记、token 照算 ——
    // 结果后缀一打上，账本还是把它当正常技能计钱，veto 白做。这里显式分账：active / disabled 两组。
    const push = (hit, disabled, extra = {}) => {
        const t = wantTokens ? tokenize(hit) : {};
        out.push({ ...hit, host: hostId, scope: opts.project ? 'project' : 'global',
            name: disabled ? String(hit.name).replace(new RegExp(DISABLE_SUFFIX + '$'), '') : hit.name,
            disabled, ...t, ...extra });
    };
    for (const name of fs.readdirSync(root)) {
        if (name.startsWith('.')) { continue; }                 // 隐藏项（.archive/.DS_Store）不算
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) { continue; }      // 散文件（zip/json）不算
        const isOff = name.endsWith(DISABLE_SUFFIX);
        const hit = classify(dir, isOff ? name.slice(0, -DISABLE_SUFFIX.length) : name, h.entry);
        if (hit) {
            push(hit, isOff);
            continue;
        }
        for (const sub of fs.readdirSync(dir)) {                 // 分类目录下探一层
            if (sub.startsWith('.')) { continue; }
            const subDir = path.join(dir, sub);
            if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) { continue; }
            const subOff = sub.endsWith(DISABLE_SUFFIX);
            const subHit = classify(subDir, subOff ? sub.slice(0, -DISABLE_SUFFIX.length) : sub, h.entry);
            if (subHit) {
                push(subHit, subOff, { category: isOff ? name.slice(0, -DISABLE_SUFFIX.length) : name });
            }
        }
    }
    // 原生通道（目前只有 hermes：config.yaml 的 skills.disabled）→ 回读一遍，
    // 否则「已被配置关掉」的条目在账本里还是活跃的，预算会以为它还在占 token。
    if (opts.nativeCheck !== false && DISABLE_MECHANISM[hostId] &&
        DISABLE_MECHANISM[hostId].strategy === 'native-config') {
        const off = nativeDisabledSet(hostId, opts);
        if (off.size) {
            for (const s of out) {
                const fm = (s.entry && !s.disabled) ? nameFromEntry(s.entry) : s.name;
                if (off.has(s.name) || (fm && off.has(fm))) { s.disabled = true; s.disabledBy = 'config'; }
            }
        }
    }
    const active = out.filter((s) => !s.disabled);
    return { host: hostId, dir: root, exists: true,
        ...(wantTokens ? {
            tokens: active.reduce((s, x) => s + (x.estTokens || 0), 0),                       // 只算还活着的
            disabledTokens: out.filter((s) => s.disabled).reduce((s, x) => s + (x.estTokens || 0), 0),
        } : {}),
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
            tokens: r.tokens || 0,                              // 活跃 token（不含已禁用的）
            disabledTokens: r.disabledTokens || 0,
            disabledTokensMeasured: r.skills.filter((s) => s.disabled && s.estTokens != null).length,
            measured: r.skills.filter((s) => !s.disabled && s.estTokens != null).length,
        };
        byHost.push(row);
        entries.push(...r.skills.map((s) => ({ ...s, skillSwitch: h.skillSwitch })));
    }
    const shaped = entries.filter((s) => !s.disabled && s.estTokens != null);
    return {
        generatedAt: new Date().toISOString(),
        hosts: byHost,
        totals: {
            entries: entries.length,
            disabled: entries.filter((s) => s.disabled).length,
            measured: shaped.length,
            skipped: entries.length - entries.filter((s) => s.disabled).length - shaped.length,
            tokens: shaped.reduce((s, x) => s + x.estTokens, 0),           // 账本总量 = 活跃技能
            disabledTokens: entries.filter((s) => s.disabled && s.estTokens != null)
                .reduce((s, x) => s + x.estTokens, 0),
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

// 启/禁用 `.disabled` 后缀。2026-10-01 逐宿主验证后的口径见 DISABLE_MECHANISM：
// hermes **不认后缀**（有源码证据），所以那条路对它 return not-effective，指到 setConfigDisabled()。
function setEnabled(hostId, name, enabled, opts = {}) {
    if (!opts.home && !opts.project) {
        throw new Error('setEnabled: must pass explicit {home} or {project} (never defaults to home)');
    }
    const mech = DISABLE_MECHANISM[hostId] || { strategy: 'suffix', verified: false };
    if (mech.strategy === 'native-config' && opts.strategy !== 'suffix') {
        return { ok: false, reason: 'host-uses-native-disabled', mechanism: 'native-config',
            hint: `use setConfigDisabled('${hostId}', ${JSON.stringify([name])}, {home|project})` };
    }
    const root = resolveDir(hostId, opts);
    const cat = opts.category || null;                       // 分类目录下的嵌套条目必须传，否则找不到
    const base = path.join(root, ...(cat ? [cat] : []), enabled ? name + DISABLE_SUFFIX : name);
    const from = opts.category ? base : path.join(root, enabled ? name + DISABLE_SUFFIX : name);
    const to = path.join(root, ...(cat ? [cat] : []), enabled ? name : name + DISABLE_SUFFIX);
    if (!fs.existsSync(from)) { return { ok: false, reason: 'not-found', from, to }; }
    fs.renameSync(from, to);
    return { ok: true, from, to, strategy: 'suffix', effective: mech.strategy === 'suffix' && !!mech.verified,
        unverified: !mech.verified, host: hostId };
}

// 宿主的真禁用通道（非侵入：默认 dry-run，写盘前先备份原文件）
function setConfigDisabled(hostId, names, opts = {}) {
    if (!opts.home && !opts.project) {
        throw new Error('setConfigDisabled: must pass explicit {home} or {project} (never defaults to home)');
    }
    const mech = DISABLE_MECHANISM[hostId];
    if (!mech || mech.strategy !== 'native-config') {
        return { ok: false, reason: 'no-native-config-support', hint: `“${hostId}”没有已知的配置禁用键` };
    }
    const cfg = path.join(opts.project ? opts.project : opts.home, mech.configPath);
    if (!fs.existsSync(cfg)) { return { ok: false, reason: 'config-not-found', hint: cfg }; }
    const raw = fs.readFileSync(cfg, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (!/^skills:\s*$/m.test(raw)) {
        return { ok: false, reason: 'no-skills-key', hint: `在 ${cfg} 里手工加：\nskills:\n  disabled: [...]` };
    }
    const topIdx = lines.findIndex((l) => l === 'skills:');
    let blockEnd = lines.length;                       // skills: 块的下边界（下一个顶层键之前）
    for (let i = topIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '' || /^\s+#/.test(l)) { continue; }
        if (l.length - l.trimStart().length === 0) { blockEnd = i; break; }
    }
    let dIdx = -1, childIndent = 2;                    // 块内第一条子项的缩进
    for (let i = topIdx + 1; i < blockEnd; i++) {
        const l = lines[i];
        if (l.trim() === '' || /^\s+#/.test(l)) { continue; }
        childIndent = l.length - l.trimStart().length;
        if (/^\s*disabled\s*:/.test(l)) { dIdx = i; break; }
    }
    const apply = opts.apply === true;
    // 语义：默认 = **禁用**（往清单里加）；`enabled: true` = 恢复启用（从清单里摘）。
    // 别把两个方向弄反 —— 上一版就栽在这，恢复调用被当成再加一遍。
    const toDisable = opts.enabled !== true;
    const names2 = (Array.isArray(names) ? names : [names]).map(String);
    const cur = dIdx >= 0 ? readYamlList(lines[dIdx], 'disabled') : [];
    const want = setDiff(cur, names2, toDisable);
    const line = `${' '.repeat(childIndent)}disabled: [${want.join(', ')}]`;
    const out = lines.slice();
    if (dIdx >= 0) { out[dIdx] = line; } else { out.splice(blockEnd, 0, line); }
    const backup = cfg + `.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (apply) {
        if (!fs.existsSync(backup)) { fs.copyFileSync(cfg, backup); }        // 回滚路径是真的，不是纸面承诺
        fs.writeFileSync(cfg, out.join('\n'), 'utf8');
    }
    return { ok: apply, dryRun: !apply, config: cfg, backup: apply ? backup : null,
        before: cur, after: want, added: toDisable ? names2 : [], removed: toDisable ? [] : names2,
        lines: out, unverified: false, host: hostId };
}
// 读宿主原生禁用清单（hermes = ~/.hermes/config.yaml 的 skills.disabled，按 skill 名，见 agent/skill_utils.py:298-310）
function nativeDisabledSet(hostId, opts = {}) {
    const mech = DISABLE_MECHANISM[hostId];
    if (!mech || mech.strategy !== 'native-config') { return new Set(); }
    const cfg = path.join(opts.project ? opts.project : (opts.home || os.homedir()), mech.configPath);
    if (!fs.existsSync(cfg)) { return new Set(); }
    const raw = fs.readFileSync(cfg, 'utf8');
    const lines = raw.split(/\r?\n/);
    const top = lines.findIndex((l) => l === 'skills:');
    if (top < 0) { return new Set(); }
    let end = lines.length;
    for (let i = top + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '' || /^\s+#/.test(l)) { continue; }
        if (l.length - l.trimStart().length === 0) { end = i; break; }
    }
    const set = new Set();
    for (let i = top + 1; i < end; i++) {
        if (/^\s*disabled\s*:/.test(lines[i])) { readYamlList(lines[i], 'disabled').forEach((n) => set.add(n)); }
    }
    return set;
}

// SKILL.md 的 frontmatter name（hermes 按它匹配清单，不是目录名 —— agent/skill_utils.py:241-253）
function nameFromEntry(entryFile) {
    try {
        const m = fs.readFileSync(entryFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!m) { return ''; }
        const nm = m[1].match(/^name:\s*(.+?)\s*$/m);
        return nm ? nm[1].replace(/^["']|["']$/g, '') : '';
    } catch (e) { return ''; }
}

function readYamlList(line, key) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*:\\s*\\[?\\s*(.*?)\\s*\\]?\\s*$`));
    if (!m) { return []; }
    return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
function setDiff(cur, names, add) {
    const s = new Set(cur);
    for (const n of names) { if (add) { s.add(n); } else { s.delete(n); } }
    return [...s].sort();
}

module.exports = {
    HOSTS, DISABLE_SUFFIX, DISABLE_MECHANISM,
    listHosts, getHost, resolveDir, scan, scanLedger, planInstall, install, setEnabled, setConfigDisabled,
    disableMechanismOf,
    toSkillMd, readSkillMd, measureSkillTokens,
};

function disableMechanismOf(hostId) {
    const m = DISABLE_MECHANISM[hostId];
    if (!m) { return { strategy: 'suffix', verified: false, reason: 'unknown-host' }; }
    return { ...m };
}
