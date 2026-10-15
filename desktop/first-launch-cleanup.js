// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// ==================== 3.3 首次启动数据清理模块（sa-2，2026-10-14）====================
// 职责：应用「首次启动」时，盘点 + 清理“开发期残留 / 测试数据”，
//       绝不碰真实用户态（providers / token / password / 活 DB / 成本账本 / 模型目录）。
//
// 架构事实（决定了本模块清理的是“哪一类残留”）：
//   · .app 是薄启动器（build.files 仅 main.js/preload.js/splash.html，实测 .app 内无
//     node_modules / db / jsonl → 干净），它从磁盘找“仓库”来跑 manager(18792)。
//   · 业务运行数据有两类落点（都不在 .app 内，在用户磁盘上）：
//       A. 仓库工作树 dev 残留：logs/、codex-proxy/trace|logs、cursor-proxy/data/
//       B. 用户态（homedir）：~/.multi-proxy-manager/、~/.multi-proxy/（manager 首跑才建）
//   · 故“安装后残留垃圾”= 旧开发机工作树里 A 类堆积 + B 类历史；全新安装二者皆空。
//
// 门控（env，默认关 = shadow，不改变任何现有行为，AGENTS §3 非侵入铁律）：
//   MPX_FIRSTLAUNCH_CLEANUP=off     （默认）影子：只算清单 + 打一行日志，零落盘、零删除
//   MPX_FIRSTLAUNCH_CLEANUP=report  算清单 + 写 manifest（JSON），不删除
//   MPX_FIRSTLAUNCH_CLEANUP=on     算清单 + 写 manifest + 删除“可删级”残留
//   MPX_CLEANUP_FORCE=1            忽略首启标记，强制重跑（否则跑过一次就停）
//
// 安全不变式（任何门控下恒成立）：
//   1. “勿删级 / 用户态”绝不删（providers.json、agent-token、password*、cost-ledger.jsonl、
//      health-history.jsonl、alert-events.jsonl、model-catalog.json、pricing.json、
//      spawn-ledger.json、预算、活 proxy.db、.encryption-key、override-audit.jsonl、launchd-live logs/）
//   2. “可删级”里若文件在“近 N 秒内被写过”= 判定为有服务在跑/正在写 → 跳过（不影响现有运行）
//   3. 只删“仓库工作树”下的可删级；homedir 用户态永远只报告、不删除
//   4. 全程 try/catch，任何异常只告警，绝不阻断 manager 启动

'use strict';

const fs = require('fs');
const path = require('path');

const ENV_GATE = 'MPX_FIRSTLAUNCH_CLEANUP';
const ENV_FORCE = 'MPX_CLEANUP_FORCE';
const MANIFEST_BASENAME = 'first-launch-cleanup.json';
const MARKER_BASENAME = '.first-launch-cleanup-done';

// 近期写过 = 可能有服务在跑/正在写 → 跳过（“不影响现有运行”的核心安全阀）
const RECENT_WRITE_MS = 2 * 60 * 1000; // 2 分钟

// ---- “可删级”：仓库工作树下的开发/测试残留，下一次运行会重建，删了不影响任何真实状态 ----
// 相对 repoRoot 的路径（目录给整条；文件给完整相对路径）
const DELETABLE_DIR = [
  'codex-proxy/trace', // dev trace 落盘目录（PROXY_TRACE_DIR），已 .gitignore
  'codex-proxy/logs',  // dev 手动/试跑日志，已 .gitignore
];
// 明确的 dev 残留文件（相对 repoRoot）
const DELETABLE_FILE = [
  'cursor-proxy/data/proxy.db-wal',       // 陈旧 SQLite 锁（cursor 不在跑时）
  'cursor-proxy/data/proxy.db-shm',       // 陈旧 SQLite 共享内存锁
  'cursor-proxy/data/pricing-cache.json', // 价表缓存，模型同步会重建
];
// 通配（repoRoot 下任意层级）：dev 改前人工备份（与 .gitignore `*.bak-*` 同款约定）
const DELETABLE_GLOBS = [
  '**/*.bak-*',
];

// ---- “勿删级 / 用户态”清单：永远只报告，绝不删除（相对 repoRoot 或 homedir）----
const NEVER_TOUCH_REPO = [
  'cursor-proxy/data/proxy.db',            // 活数据库
  'cursor-proxy/data/override-audit.jsonl',// 审计轨迹（append-only）
  'cursor-proxy/.encryption-key',          // 加密密钥
  'logs',                                  // 可能 launchd 在写的活动日志（保留，只报告）
];
// homedir 用户态目录（整目录报告，不删除）
const STATE_DIRS_HOMEDIR = [
  '.multi-proxy-manager', // manager 状态：providers/账本/token/密码/模型目录/价表…
  '.multi-proxy',         // 估算缓存 / floor feed
];

// 解析门控：显式入参 > env > 默认 off
function resolveGate(explicit) {
  if (explicit) return explicit;
  const v = String(process.env[ENV_GATE] || '').toLowerCase();
  if (v === 'on' || v === 'report') return v;
  return 'off'; // 默认关 = shadow
}

function resolveForce(explicit) {
  if (explicit !== undefined) return !!explicit;
  return String(process.env[ENV_FORCE] || '').toLowerCase() === '1';
}

// 收集 repoRoot 下的 **/*.bak-*（简易递归，忽略 node_modules）
function collectBakFiles(root) {
  const out = [];
  function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(abs);
      else if (/\.bak-/.test(e.name)) out.push(path.relative(root, abs));
    }
  }
  try { walk(root); } catch { /* root 不可读则空 */ }
  return out;
}

// 单文件 mtime 判断（读失败视为“可删”，但删除处仍会 try/catch 兜底）
function isRecentWrite(abs, now) {
  try {
    const st = fs.statSync(abs);
    return (now - st.mtimeMs) < RECENT_WRITE_MS;
  } catch {
    return false;
  }
}
function fileSize(abs) {
  try { return fs.statSync(abs).size; } catch { return 0; }
}

function listDir(abs) {
  try { return fs.readdirSync(abs).filter(n => n !== '.DS_Store'); } catch { return []; }
}

// 核心入口。opts 全部可注入 → 可单测 / 可被 electron main.js 直接调用。
// 返回结构化 result；本身「绝不抛异常」（外层仍 try/catch，双保险）。
function runFirstLaunchCleanup(opts = {}) {
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';
  const repoRoot = opts.repoRoot || '';
  const gate = resolveGate(opts.gate);
  const force = resolveForce(opts.force);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const log = opts.log || (() => {});
  let doDelete = gate === 'on';           // 只有 on 才真删（alreadyDone 时降级为 false，故用 let）
  const writeManifest = gate !== 'off';     // report/on 都落 manifest
  const shadow = gate === 'off';

  const stateDir = home ? path.join(home, '.multi-proxy-manager') : '';
  const manifestPath = opts.manifestPath || (stateDir ? path.join(stateDir, MANIFEST_BASENAME) : '');
  const markerPath = opts.markerPath || (stateDir ? path.join(stateDir, MARKER_BASENAME) : '');

  const result = {
    gate,
    shadow,
    doDelete,
    alreadyDone: false,
    ran: false,
    deletable: [],
    neverTouch: [],
    stateFiles: [],
    manifestPath: writeManifest ? manifestPath : null,
    log: [],
  };
  const note = (m) => { result.log.push(m); log(m); };

  // 首启标记：跑过一次就停（除非 force）。标记只影响“是否执行删除”，不影响“报告”。
  if (doDelete) {
    try {
      if (fs.existsSync(markerPath) && !force) {
        result.alreadyDone = true;
        doDelete = false; // 降级为 report（仍写 manifest，不删）
        result.doDelete = false;
        note(`[cleanup] 首启标记已存在（${path.basename(markerPath)}）且未 force → 本次仅报告，不删除。`);
      }
    } catch { /* 标记读失败按“需执行”处理 */ }
  }

  // ---- A. 可删级（仓库工作树）----
  const candidateRel = [];
  for (const d of DELETABLE_DIR) candidateRel.push({ kind: 'dir', rel: d });
  for (const f of DELETABLE_FILE) candidateRel.push({ kind: 'file', rel: f });
  for (const g of DELETABLE_GLOBS) {
    if (g === '**/*.bak-*') for (const rel of collectBakFiles(repoRoot)) candidateRel.push({ kind: 'file', rel });
  }

  for (const c of candidateRel) {
    const abs = path.join(repoRoot, c.rel);
    if (c.kind === 'dir') {
      // 目录：逐个删其中“非近期写”的文件；空目录删掉，非空保留
      const names = listDir(abs);
      let removed = 0;
      for (const n of names) {
        const fa = path.join(abs, n);
        if (isRecentWrite(fa, now)) {
          result.deletable.push({ rel: c.rel + '/' + n, abs: fa, size: fileSize(fa), deleted: false, skippedReason: 'live（近 2min 内被写过，可能有服务在跑）' });
          continue;
        }
        if (doDelete) {
          try { fs.rmSync(fa, { force: true }); removed++; } catch { /* 单个失败不影响其余 */ }
        }
        result.deletable.push({ rel: c.rel + '/' + n, abs: fa, size: fileSize(fa), deleted: doDelete, skippedReason: null });
      }
      if (doDelete && removed > 0) {
        try { fs.rmSync(abs, { recursive: true, force: true }); } catch { /* 目录可能仍被占用 */ }
      }
      result.deletable.push({ rel: c.rel + '/', abs, size: 0, deleted: doDelete, skippedReason: null, isDir: true, removedContents: doDelete ? removed : 0 });
    } else {
      const exists = fs.existsSync(abs);
      const recent = exists && isRecentWrite(abs, now);
      const willDelete = doDelete && exists && !recent;
      if (willDelete) {
        try { fs.rmSync(abs, { force: true }); } catch { /* 单文件失败兜底 */ }
      }
      result.deletable.push({
        rel: c.rel, abs, size: fileSize(abs), exists,
        deleted: willDelete,
        skippedReason: !exists ? null : (recent ? 'live（近 2min 内被写过，可能有服务在跑）' : (doDelete ? null : 'gate=report/off（仅报告）')),
      });
    }
  }

  // ---- B. 勿删级（仓库工作树，仅报告）----
  for (const rel of NEVER_TOUCH_REPO) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) result.neverTouch.push({ rel, abs, size: fileSize(abs) });
  }

  // ---- C. 用户态（homedir，仅报告，绝不删）----
  for (const d of STATE_DIRS_HOMEDIR) {
    const abs = path.join(home, d);
    for (const n of listDir(abs)) {
      const fa = path.join(abs, n);
      result.stateFiles.push({ rel: d + '/' + n, abs: fa, size: fileSize(fa) });
    }
  }

  // ---- manifest（report / on 才落盘；on 时顺带写首启标记）----
  if (writeManifest && manifestPath) {
    const manifest = {
      generatedAt: new Date(now).toISOString(),
      gate,
      shadow,
      doDelete: result.doDelete,
      alreadyDone: result.alreadyDone,
      repoRoot,
      home,
      deletable: result.deletable,
      neverTouch: result.neverTouch,
      stateFiles: result.stateFiles,
      policy: {
        RECENT_WRITE_MS,
        gateEnv: ENV_GATE,
        forceEnv: ENV_FORCE,
        deletableDirs: DELETABLE_DIR,
        deletableFiles: DELETABLE_FILE,
        deletableGlobs: DELETABLE_GLOBS,
        neverTouchRepo: NEVER_TOUCH_REPO,
        stateDirsHomedir: STATE_DIRS_HOMEDIR,
      },
    };
    try {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      note(`[cleanup] manifest → ${manifestPath}`);
    } catch (e) {
      note(`[cleanup] ⚠️ manifest 写失败（忽略，不影响启动）：${e && e.message}`);
      result.manifestPath = null;
    }
  }

  // 首启标记：只有“真删过”（on 且非 alreadyDone）才写 → 下次启动自动跳过
  if (result.doDelete && !result.alreadyDone && markerPath) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, new Date(now).toISOString() + '\n');
      result.ran = true;
      note(`[cleanup] 已删除可删级残留，首启标记 → ${path.basename(markerPath)}`);
    } catch { /* 标记写失败不影响 */ }
  }

  // 摘要（默认 off 也只打这一行，保证“不影响现有运行”）
  const nDeleted = result.deletable.filter(x => x.deleted && !x.skippedReason).length;
  const nSkipped = result.deletable.filter(x => x.skippedReason).length;
  note(
    `[cleanup] gate=${gate}${shadow ? '（shadow，零落盘）' : ''} 可删命中=${result.deletable.length} 删除=${nDeleted} 跳过=${nSkipped} ` +
    `勿删=${result.neverTouch.length} 用户态=${result.stateFiles.length}`
  );
  return result;
}

module.exports = {
  runFirstLaunchCleanup,
  resolveGate,
  resolveForce,
  collectBakFiles,
  // 导出常量便于单测 / 文档引用
  ENV_GATE, ENV_FORCE, RECENT_WRITE_MS,
  DELETABLE_DIR, DELETABLE_FILE, DELETABLE_GLOBS,
  NEVER_TOUCH_REPO, STATE_DIRS_HOMEDIR,
};
