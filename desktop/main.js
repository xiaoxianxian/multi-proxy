// ==================== Proxy Manager 桌面壳 ====================
// 职责边界（重要）:
//   - 壳只负责: 开窗口 + 确保 manager(18792) 在跑 + 退出时按需回收
//   - codex/hermes/cursor 三个代理进程由 manager 管理，壳绝不直接碰
//   - 附着模式: manager 已在跑(原生或 LaunchAgent)时只开窗口，
//     退出不杀 —— 避免断连正在使用代理的 Codex CLI / Hermes Agent
// 铁律: 绝不写全局 NO_PROXY / launchctl setenv（见 CLAUDE.md）

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const MANAGER_PORT = 18792;
const MANAGER_URL = `http://127.0.0.1:${MANAGER_PORT}`;
// 仓库根解析顺序:
//   1. 环境变量 PROXY_MANAGER_REPO（显式覆盖）
//   2. 打包版: ~/proxy-rebuild（壳是启动器，业务代码常驻仓库目录，
//      不塞进 .app —— 避免 better-sqlite3 ABI 与双份 node_modules 问题）
//   3. 开发模式: desktop/..
function resolveRepoRoot() {
  if (process.env.PROXY_MANAGER_REPO) return process.env.PROXY_MANAGER_REPO;
  const home = app.getPath('home');
  const candidates = app.isPackaged
    ? [path.join(home, 'proxy-rebuild')]
    : [path.join(__dirname, '..')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'multi-proxy-manager', 'server.js'))) return c;
  }
  return candidates[0];
}
const REPO_ROOT = resolveRepoRoot();

let mainWindow = null;
let managerProc = null;      // 壳拉起的 manager 子进程（非 null 才负责退出时回收）
let attachedToExternal = false; // manager 是外部启动的（附着模式）

// ---------- HTTP 探测 ----------
function probeManager(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`${MANAGER_URL}/api/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitUntilUp(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probeManager(500)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ---------- PATH 修复 ----------
// GUI 应用从 Finder/Dock 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin。
// manager 的 lsof 检测用绝对路径没问题，但它 spawn 的 node/python3、
// 以及 hermes-proxy 的 python3 都需要完整 PATH。这里显式补齐。
function buildEnv() {
  const home = app.getPath('home');
  const extraPaths = [
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const env = { ...process.env };
  env.PATH = extraPaths.join(':') + ':' + (env.PATH || '');
  // 仅对本进程树生效的 localhost 直连豁免（绝不用 launchctl setenv 污染全局）
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';
  return env;
}

// ---------- Manager 生命周期 ----------
function portInUse() {
  try {
    execSync(`/usr/sbin/lsof -iTCP:${MANAGER_PORT} -sTCP:LISTEN`,
      { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false; // exit code 1 = 无监听
  }
}

function startManager() {
  const serverJs = path.join(REPO_ROOT, 'multi-proxy-manager', 'server.js');
  if (!fs.existsSync(serverJs)) {
    dialog.showErrorBox(
      '找不到服务代码',
      `未在以下位置找到 multi-proxy-manager/server.js:\n${REPO_ROOT}\n\n` +
      '如果是打包版，请确认仓库已随应用打包；如果是开发版，请在项目根目录运行。'
    );
    return null;
  }
  const proc = spawn(process.execPath === '' ? 'node' : 'node', [serverJs], {
    cwd: path.dirname(serverJs),
    env: buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => console.log('[manager]', d.toString().trim()));
  proc.stderr.on('data', d => console.error('[manager:err]', d.toString().trim()));
  proc.on('exit', (code) => {
    console.log(`[manager] exited with ${code}`);
    if (!app.isQuittingInternal && !mainWindow?.isDestroyed()) {
      // manager 意外退出：提示但不自动重启（manager 自带崩溃恢复语义）
      dialog.showErrorBox('管理服务已退出', `manager 进程退出(code=${code})，请重启应用。`);
    }
  });
  return proc;
}

async function ensureManager() {
  if (await probeManager()) {
    attachedToExternal = true;
    console.log('[shell] attach mode: manager already running externally');
    return true;
  }
  if (portInUse()) {
    // 端口被占但 /api/version 探不通：可能是启动中，等一下再探
    if (await waitUntilUp(5000)) {
      attachedToExternal = true;
      return true;
    }
    dialog.showErrorBox('端口冲突',
      `端口 ${MANAGER_PORT} 被其它进程占用且不是 Proxy Manager。\n` +
      '请释放端口后重试。');
    return false;
  }
  managerProc = startManager();
  if (!managerProc) return false;
  const up = await waitUntilUp();
  if (!up) {
    dialog.showErrorBox('启动失败',
      `manager 在 15 秒内未能就绪，请查看日志:\n~/.multi-proxy-manager/logs/`);
    return false;
  }
  return true;
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Proxy Manager',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(MANAGER_URL);

  // 页内所有新窗口/外链走系统浏览器，不在壳里开新 Electron 窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- 退出策略 ----------
let isQuittingInternal = false;

app.whenReady().then(async () => {
  const ok = await ensureManager();
  if (!ok) {
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS 惯例：点红叉只是关窗，应用留在 Dock；Cmd+Q 才真正退出并回收进程
  // （与用户预期一致：关窗 ≠ 停代理）
});

app.on('before-quit', () => {
  isQuittingInternal = true;
});

app.on('will-quit', () => {
  // 只回收自己拉起的 manager；外部启动的不动（附着模式）
  if (managerProc && !attachedToExternal) {
    try {
      managerProc.kill('SIGTERM');
      // 给 800ms 优雅期，没死再 SIGKILL（与 manage.sh 两阶段策略一致）
      const deadline = Date.now() + 800;
      while (Date.now() < deadline && managerProc.exitCode === null) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (managerProc.exitCode === null) managerProc.kill('SIGKILL');
    } catch { /* best effort */ }
  }
});
