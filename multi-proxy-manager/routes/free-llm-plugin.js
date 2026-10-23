// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// ==================== 路由：免费模型聚合插件（free-llm） ====================
// 把 free-llm 插件的「安装 / 卸载 / 状态」暴露到 manager 面板，遵循「一切皆插件」：
//   - 默认不安装（seed 仅声明，install.sh 才注入 live providers.json）；
//   - 写操作挂 requireAuth（与 manager 其它写操作一致）；
//   - 只执行仓库内 free-llm/*.sh，命令路径为常量、无外部输入，杜绝命令注入。
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { requireAuth } = require('../lib/auth');

const router = express.Router();

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'free-llm');
const LIVE = path.join(os.homedir(), '.multi-proxy-manager', 'providers.json');

// 风险告知（前端直接展示，与 manifest.disclaimer / README 同源）
const DISCLAIMER = [
  '免费模型来自 OpenRouter / Groq / 硅基流动 / Vercel / OpenCode Zen / Kilo 的免费额度，非 multi-proxy 提供。',
  '无 SLA：免费源可随时收紧、涨价、取消，本插件不对其存续担责。',
  '仅限个人自用；商用 / 转售前须逐家核对各家 ToS。',
  '各家免费目录不重叠，429 切换后可能落到另一家不同模型，属预期行为。',
  '卸载只移除 free-llm-* 条目，不动其它 provider、不重启、不删数据。',
  '【匿名源 Kilo】上游可能把你的 prompt / 工具返回内容用于改进服务，敏感代码与私有资料勿走此车道。',
  '【匿名源 Kilo】限约 200 次请求 / 小时 / IP，且无账号、无额度申诉通道；高并发或生产请走自带 key 的源。',
];

function readLiveProviders() {
  try {
    const data = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function listInstalled() {
  return readLiveProviders()
    .filter((p) => String(p.id || '').startsWith('free-llm-'))
    .map((p) => ({ id: p.id, name: p.name, anonymous: !!p.is_anonymous }));
}

// 状态（只读，不挂 auth）
router.get('/status', (_req, res) => {
  const installed = listInstalled();
  res.json({
    installed: installed.length > 0,
    kiloAnonymous: installed.some((p) => p.id === 'free-llm-kilo'),
    providers: installed,
    disclaimer: DISCLAIMER,
  });
});

// 执行仓库内固定脚本（路径为常量，无用户可控输入 → 无命令注入面）
function runScript(name, res) {
  const script = path.join(PLUGIN_DIR, name);
  if (!fs.existsSync(script)) {
    return res.status(404).json({ success: false, error: `插件脚本缺失：${name}` });
  }
  execFile(
    'bash',
    [script],
    { cwd: REPO_ROOT, timeout: 120000, maxBuffer: 5 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().slice(-4000);
      if (err) {
        const exitCode = err.code === 'ETIMEDOUT' ? -1 : (err.code || 1);
        return res.json({ success: false, exitCode, output, error: err.message });
      }
      return res.json({ success: true, output });
    },
  );
}

router.post('/install', requireAuth, (_req, res) => runScript('install.sh', res));
router.post('/uninstall', requireAuth, (_req, res) => runScript('uninstall.sh', res));

module.exports = router;
