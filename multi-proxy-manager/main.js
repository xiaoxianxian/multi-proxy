'use strict';

// Multi-Proxy Manager — Electron 壳（P5，MVP）。
// 作用：把已落地、已接线的 Express 管理后台（server.js）装进桌面壳，
//      双击即可「打开应用 → 拉起/复用 Web 后端 → 装载 UI」，整体安装/卸载。
//
// 三点核心（老板诉求）：
//   1. 开壳前先调 agent-owner.detectAll() 做 base_url 占用冲突检查
//      （复用 proxy-control.js:93 同款逻辑，不重复实现），
//      冲突时弹警示；硬拦已落在 openAgent 调用侧（占用则报错不开启并关该 agent 开关）。
//   2. 自包含：若 18792 已 LISTEN 则复用，否则 spawn 后端 node server.js
//      并等端口就绪，再 loadURL 本地 UI。
//   3. 非侵入：零改动 server.js / agent-owner.js / 各 proxy；本壳独立入口，
//      仅当 electron 运行时生效，不影响 `node server.js`。
//
// 打包/签名/分装（.app/.dmg/公证）不在 MVP 范围——见 manage.sh gui-build 说明。
const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const { detectAll } = require('./lib/agent-owner');

const PORT = process.env.PORT || 18792;
const BASE_URL = 'http://localhost:' + PORT;

// 探测端口是否已有 HTTP 服务在监听；true 表示可复用。
function portUp(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: p, path: '/', timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
     });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 后端已就绪则不 spawn，避免双开抢占端口。
async function ensureBackend() {
  for (let i = 0; i < 40; i += 1) { // 40×300ms ≈ 12s 上限
    if (await portUp(PORT)) return null; // 复用现有后端，不接管
    break;
  }
  // 未就绪——spawn 本目录 server.js 作为子进程后端。
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: 'inherit',
   });
  for (let i = 0; i < 60; i += 1) { // 再等 18s 上限
    if (await portUp(PORT)) return server;
    await new Promise((r) => setTimeout(r, 300));
   }
  dialog.showErrorBox('后端启动超时', 'Manager Web 后端（端口 ' + PORT +
    '）12s 内未就绪。请查看日志：`npm run logs manager`。');
  server.kill();
  return null;
}

// 占检测：开壳前跑一次 detectAll，冲突时弹警示（不硬拦——硬拦在调用侧）。
function warnIfOccupied() {
  const conf = detectAll();
  const hit = Object.entries(conf).filter(([, c]) => c.occupied);
  if (hit.length === 0) return;
  const lines = hit.map(([a, c]) => '  ' + a + ': ' + c.baseUrl + '  →  ' + c.by);
  dialog.showMessageBoxSync({
    type: 'warning',
     title: 'base_url 占用冲突',
    message: '以下 agent 的 base_url 已被其它工具占用：',
    detail: lines.join('\n') +
     '\n\n开启这些 agent 时，后台会自动拦截并关闭对应开关（详见 proxy-control.js）。',
   });
  console.warn('[electron][occupancy] ' + JSON.stringify(conf));
}

let backend = null;

function openManagerWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Multi-Proxy Manager',
    webPreferences: {
       // 本地受信源，contextIsolation 保持；不开启 nodeIntegration，不注入远端代码。
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
     },
   });
  win.loadURL(BASE_URL);
  return win;
}

app.whenReady().then(async () => {
  warnIfOccupied();
  backend = await ensureBackend();
  openManagerWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openManagerWindow();
   });
});

// 关窗退出：回收本壳 spawn 的后端子进程（复用的后端不动）。
function shutdown() {
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
   }
}

app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', shutdown);
