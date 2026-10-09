// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// h3web Guard — 外部本地服务（h3web :8731）的「检测 + 提醒 + 可选一键开启」。
//
// 设计动机（维护者 2026-10-10）：h3web 是独立本地项目，不该由 multi-proxy 替它配
// launchd 常驻；正确分工是 —— multi-proxy 在使用侧**发现它没起就提醒**，并留一个
// 显式授权的「一键开启」入口。默认态零副作用。
//
// 不变式：
//   1. probe() 严格只读 —— 只发 GET /，绝不 POST /api/gen（那会触发引擎冷加载）。
//   2. start() 受 PROXY_H3WEB_AUTOSTART 门控（默认关 = 405 + 提示，绝不擅自拉起
//      外部进程）。与 provider-health / skill-hosts / mcp 同一门控范式。
//   3. spawn 用 detached + unref，子进程脱离 manager 生命周期独立存活。
//   4. 与代理路由零耦合：本模块不碰 PROVIDERS / 路由决策，失败只影响提醒。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8731;

// 脚本候选：env 优先，其次本机已知安装位（h3web 是维护者本地独立项目，路径带中文）。
// 不做目录递归扫描（慢且易误命中），只认显式配置 + 已知路径。
function candidateScripts() {
  return [
    process.env.PROXY_H3WEB_SCRIPT,
    path.join(os.homedir(), 'Documents', 'AI项目', '本地部署Minimax H3', 'h3web.py'),
  ].filter(Boolean);
}

// 解析出「存在且可读」的 h3web 启动脚本；全都不在则返回 null（提醒里会要求配置 env）。
function resolveScript() {
  for (const p of candidateScripts()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) { /* 继续下一个候选 */ }
  }
  return null;
}

function targetPort() {
  const n = parseInt(process.env.PROXY_H3WEB_PORTS || process.env.H3WEB_PORT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

// 只读探活：连得上且 2xx/3xx 视为 up（真 h3web 的 GET / 在关闭过程中曾返回 307，
// 判死要严：只有 ECONNREFUSED / 超时 / 5xx 才算 down）。
function probe(opts) {
  const port = (opts && opts.port) || targetPort();
  const timeoutMs = (opts && opts.timeoutMs) || 2000;
  return new Promise(function (resolve) {
    const req = http.request(
      { host: '127.0.0.1', port: port, path: '/', method: 'GET', timeout: timeoutMs },
      function (res) {
        const code = res.statusCode;
        res.resume();
        resolve({
          up: code >= 200 && code < 400,
          port: port,
          statusCode: code,
          checkedAt: new Date().toISOString(),
        });
      }
    );
    req.on('error', function (e) {
      resolve({
        up: false,
        port: port,
        statusCode: null,
        error: e && e.code ? e.code : String(e && e.message || e),
        checkedAt: new Date().toISOString(),
      });
    });
    req.on('timeout', function () {
      req.destroy();
      resolve({ up: false, port: port, statusCode: null, error: 'TIMEOUT', checkedAt: new Date().toISOString() });
    });
    req.end();
  });
}

// 提醒文案：给人和给 UI 共用一份，避免两处口径漂移。
function advice(probeResult) {
  const script = resolveScript();
  const port = probeResult ? probeResult.port : targetPort();
  if (probeResult && probeResult.up) {
    return {
      level: 'ok',
      message: `h3web 已在 127.0.0.1:${port} 运行，L2 executor 可直接接。`,
      action: null,
    };
  }
  const why = probeResult && probeResult.error ? probeResult.error : `HTTP ${probeResult && probeResult.statusCode}`;
  if (!script) {
    return {
      level: 'error',
      message: `h3web 未运行（${why}），且没找到启动脚本。请设置 PROXY_H3WEB_SCRIPT=/path/to/h3web.py。`,
      action: null,
    };
  }
  return {
    level: 'warn',
    message: `h3web 未运行（${why}）。L2 executor 的 h3web 通道当前不可用 —— 提交任务会失败。`,
    action: {
      kind: 'start',
      script: script,
      command: `/usr/bin/python3 "${script}"`,
      api: `POST /api/h3web/start`,
      gate: 'PROXY_H3WEB_AUTOSTART',
      note: '门控默认关；开启后该接口才会真拉起外部进程。',
    },
  };
}

function autostartEnabled() {
  return process.env.PROXY_H3WEB_AUTOSTART === '1';
}

// 一键开启：仅在门控开（或调用方显式授权 force）时真 spawn。
// force 的语义：调用方已拿到人类显式指令（如 CLI --start），不算「擅自拉起」，
// 故跳过 env 门控；HTTP 面永远不传 force，只能靠 PROXY_H3WEB_AUTOSTART 开。
// 成功返回 pid，失败带原因（绝不抛未捕获异常）。
function start(opts) {
  const script = (opts && opts.script) || resolveScript();
  const force = !!(opts && opts.force);
  if (!script) {
    return Promise.resolve({ ok: false, error: 'no script: set PROXY_H3WEB_SCRIPT=/path/to/h3web.py' });
  }
  if (!force && !autostartEnabled()) {
    return Promise.resolve({
      ok: false,
      gated: true,
      error: 'PROXY_H3WEB_AUTOSTART≠1 → 拒绝拉起外部进程（默认零副作用）。启动时加该 env 后重试。',
    });
  }
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn('/usr/bin/python3', [script], {
        cwd: path.dirname(script),
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env),
      });
      child.unref();
    } catch (e) {
      return resolve({ ok: false, error: 'spawn failed: ' + (e && e.message) });
    }
    // 异步确认：给服务 3s 启动窗口后回探一次，避免「起了但没监听」被误报成功。
    const port = targetPort();
    setTimeout(function () {
      probe({ port: port }).then(function (r) {
        resolve({ ok: r.up, pid: child.pid, port: port, probe: r });
      });
    }, 3000);
  });
}

// 聚合视图：路由与 CLI 共用，保证 HTTP 面和终端面口径一致。
function snapshot(opts) {
  return probe(opts).then(function (r) {
    return {
      ok: true,
      up: r.up,
      port: r.port,
      statusCode: r.statusCode,
      error: r.error || null,
      checkedAt: r.checkedAt,
      script: resolveScript(),
      autostartEnabled: autostartEnabled(),
      advice: advice(r),
    };
  });
}

module.exports = {
  DEFAULT_PORT: DEFAULT_PORT,
  candidateScripts: candidateScripts,
  resolveScript: resolveScript,
  targetPort: targetPort,
  probe: probe,
  advice: advice,
  autostartEnabled: autostartEnabled,
  start: start,
  snapshot: snapshot,
};
