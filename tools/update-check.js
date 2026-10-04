#!/usr/bin/env node
'use strict';

// 更新检测（2026-10-04）
//
// 之前「有没有新版本」这事是完全没有通道的：四份 package.json 各写各的，
// /api/version 读的那个路径还不存在，一路 catch 回硬编码 1.0.0。维护者的年度订阅
// 写的是「含更新」，可通胀情况下没有任何东西能把「更新」这件事传到用户眼前。
//
// 通道按评估文档选的 A 方案：**GitHub Releases 当版本源，一次无参 GET 比 tag**。
// 理由（见 docs/04-business/更新通道评估-2026-10-04.md）：
//   - 零服务端、零账号、零凭据，纯 stdlib 二十几行
//   - 不碰 npm（这项目是本地代理不是库，发到 npm 也装不出二进制加 launchd）
//   - 不用 electron-updater（打包要 Apple 证书，通常的「应用损坏」弹窗就是这个来的）
//   - 不发任何东西出去，与「数据不出本机」不冲突；README 里要主动写一句解释
//
// 用法：
//   node tools/update-check.js            人看：有新版就给命令
//   node tools/update-check.js --json     给 /api/version 或脚本吃
//   node tools/update-check.js --off      显式关闭（README 里教用户怎么关）
//
// 任何一步失败（断网 / 限流 / 不是 git 仓库）都**静默退出 0**：
// 更新提示是增益，不能变成每天弹在日志里的错误刷屏。

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('tls');

const ROOT = path.join(__dirname, '..');
const OWNER = process.env.MP_OWNER || 'xiaoxianxian';
const REPO = process.env.MP_REPO || 'multi-proxy';
// 换成别的 host 就能拿假 API 试（本地起个假 GitHub 跑测试，不需要真网络）
const API_HOST = process.env.MP_API_HOST || 'api.github.com';
const TIMEOUT_MS = 4000;

/** 从 VERSION 取当前版本（与 tools/sync-version.js 同一份真源，别再读第二处） */
function currentVersion() {
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const v = lines[0];
    return /^\d+\.\d+\.\d+/.test(v || '') ? v : null;
  } catch {
    return null;
  }
}

function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 返回 1 表示 a>b，0 相等，-1 表示 a<b。解析不出来当相等（不该报错打断主流程）。 */
function compare(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

// 国内直连 api.github.com 基本是不通的（实测 install.sh --check-update 一路
// unreachable），那这条通道对用户就是死的。Node 的 https 不认系统代理，也不认
// http_proxy 那套环境变量，所以这里自己读一遍：MP_PROXY 优先，退回标准的
// HTTPS_PROXY / https_proxy / ALL_PROXY / all_proxy。不硬编任何端口——
// 用谁的代理就自己在 shell 里 export 成谁，脚本不替用户猜。
function proxyFor() {
  const raw = process.env.MP_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.hostname ? u : null;
  } catch {
    return null;
  }
}

/** 走代理的话得先 CONNECT 打洞，再把 TLS 架在洞上（纯 stdlib，不引第三方） */
function tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      timeout: TIMEOUT_MS,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchLatest() {
  const url = `/repos/${OWNER}/${REPO}/releases/latest`;
  const proxy = proxyFor();
  let socket = null;
  if (proxy) {
    socket = tls.connect({ socket: await tunnel(proxy, API_HOST, 443), servername: API_HOST });
    // 必须等 TLS 握手完。socket 是预先连好的，不等 secureConnect 就把请求写出去的话，
    // 出去的是明文，GitHub 回 400。
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    // 注意：不能 https.get(url, options) —— 第一个字符串参数会被当完整 URL 解析，
    // 而这里传的是 path（"/repos/..."），Node 会抛 ERR_INVALID_URL。只给 options。
    const req = https.get({
      host: API_HOST,
      path: url,
      // agent: false 必须带：默认的全局 agent 会自己再开一条连接，把预连好的
      // 隧道 socket 架空，请求走直连出去，GitHub 回 400
      agent: false,
      createConnection: socket ? () => socket : undefined,
      host: API_HOST,
      path: url,
      headers: {
        'user-agent': 'multi-proxy-update-check',
        accept: 'application/vnd.github+json',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      // GitHub 匿名 60 次/小时，撞 403 就当没这回事（限流是它的问题，不是用户的）。
      // 404 单独标出来：那不是连不上，是这仓库还没发过 release——两种原因对用户完全不是一回事。
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.reason = res.statusCode === 404 ? 'no-release-yet' : 'http-error';
        reject(err);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('响应不是 JSON'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    // 复用洞里的 socket 时 https 的 timeout 选项不会触发，自己挂一个
    if (socket) socket.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

function main() {
  const args = process.argv.slice(2);
  // 环境变量版开关：给 install.sh / cron 用（README 里教用户怎么关）
  if (args.includes('--off') || process.env.MP_UPDATE_OFF) {
    process.stdout.write(JSON.stringify({ checked: false, reason: 'disabled' }) + '\n');
    return 0;
  }

  const current = currentVersion();
  if (!current) {
    process.stdout.write(JSON.stringify({ checked: false, reason: 'no-version-file' }) + '\n');
    return 0;
  }

  const jsonOnly = args.includes('--json');
  return fetchLatest().then((rel) => {
    const latest = String(rel && rel.tag_name || '').replace(/^v/, '');
    const cmp = compare(latest, current);
    const out = {
      checked: true,
      current,
      latest: latest || null,
      upToDate: cmp <= 0,
      publishedAt: rel && rel.published_at ? rel.published_at : null,
      note: (rel && rel.body ? String(rel.body).split('\n').find((l) => l.trim()) || '' : ''),
    };
    if (jsonOnly) {
      process.stdout.write(JSON.stringify(out) + '\n');
      return out.upToDate ? 0 : 1;
    }
    if (out.upToDate) {
      process.stdout.write(`已是最新（${current}）\n`);
      return 0;
    }
    process.stdout.write(
      `有新版：${latest}` +
      (out.publishedAt ? `（${out.publishedAt.slice(0, 10)}）` : '') +
      `\n升级：git pull && ./install.sh\n`
    );
    return 1;
  }).catch((e) => {
    // 静默：更新提示不该变成错误日志。但原因要带出去——
    // unreachable（断网/没代理）和 no-release-yet（仓库还没发版）debug 方向完全不同。
    if (jsonOnly) {
      process.stdout.write(JSON.stringify({
        checked: false,
        reason: (e && e.reason) || 'unreachable',
      }) + '\n');
    }
    return 0;
  });
}

module.exports = { compare, parseVer, currentVersion, fetchLatest, proxyFor };

if (require.main === module) {
  // 出任何岔子都不许把调用方带崩
  Promise.resolve(main())
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch(() => process.exit(0));
}
