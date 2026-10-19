#!/usr/bin/env bash
# free-llm · 安装：把 3 家免费 provider add-only 合并进 live providers.json（先备份，幂等）
# 依赖：generic-openai-proxy（18799）。加 key 不用重启它（每请求重读 providers.json）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DATA_DIR="$HOME/.multi-proxy-manager"
LIVE="$DATA_DIR/providers.json"
SEED="$HERE/providers.seed.json"
GENERIC_PORT=18799

# 1) 读 key：优先 free-llm/.env，其次环境变量（真实 key 只落在 .env，已被 gitignore）
if [ -f "$HERE/.env" ]; then
  echo "· 读取 $HERE/.env"
  set -a; source "$HERE/.env"; set +a
fi

mkdir -p "$DATA_DIR"
[ -f "$LIVE" ] || echo "[]" > "$LIVE"
BACKUP="$LIVE.bak-$(date +%s)"
cp -p "$LIVE" "$BACKUP"
echo "· 已备份 live providers.json → $BACKUP"

# 2) add-only 合并：已存在的 id 原样保留（不覆盖用户的 key/改动），缺失的 key 注入 .env 值
LIVE="$LIVE" SEED="$SEED" OR_KEY="${OPENROUTER_FREE_KEY:-}" \
GROQ_KEY="${GROQ_FREE_KEY:-}" SIL_KEY="${SILICONFLOW_FREE_KEY:-}" node - <<'JS'
const fs = require('fs');
const live = JSON.parse(fs.readFileSync(process.env.LIVE, 'utf8'));
const seed = JSON.parse(fs.readFileSync(process.env.SEED, 'utf8'));
const keys = { openrouter: process.env.OR_KEY || '', groq: process.env.GROQ_KEY || '', siliconflow: process.env.SIL_KEY || '' };
let added = 0, filled = 0, placeholder = 0;
for (const e of seed) {
  const k = keys[e.provider_id] || '';
  const realKey = (k && !/^__FILL_/.test(k)) ? k : null;
  const i = live.findIndex(p => p.id === e.id);
  if (i === -1) {
    e.api_key = realKey || e.api_key;
    live.push(e); added++;
    if (!realKey) placeholder++;
    console.log(`  + ${e.name}（${e.provider_id}）key: ${realKey ? '已填' : '占位·待填'}`);
  } else {
    const cur = live[i];
    const wasPlaceholder = !cur.api_key || /^__FILL_/.test(cur.api_key);
    // 幂等：刷新清单/基址/免责；占位 key 可升级成真 key；已有真 key 绝不覆盖
    Object.assign(cur, { name: e.name, base_url: e.base_url, enabled: e.enabled, models: e.models, fallback: e.fallback, _note: e._note });
    if (wasPlaceholder) { cur.api_key = realKey || cur.api_key; if (realKey) filled++; }
    console.log(`  = ${e.id} 已存在：刷新模型清单${wasPlaceholder && realKey ? '，并填入 key' : wasPlaceholder ? '（key 仍占位）' : '（保留已有 key）'}`);
  }
}
fs.writeFileSync(process.env.LIVE, JSON.stringify(live, null, 2) + '\n');
try { fs.chmodSync(process.env.LIVE, 0o600); } catch (_) {}
console.log(`· 新增 ${added} 家，升级 key ${filled} 家（其中 ${placeholder} 家 key 仍占位）`);
JS

# 3) 确保 18799 在跑（没跑就起 generic-openai-proxy）
if ! curl -s -m 3 "http://127.0.0.1:$GENERIC_PORT/health" >/dev/null 2>&1; then
  echo "· 18799 未运行，启动 generic-openai-proxy ..."
  nohup node "$REPO/generic-openai-proxy/proxy.js" > "$DATA_DIR/generic-openai-proxy.free-llm.log" 2>&1 &
  for _ in $(seq 1 20); do curl -s -m 2 "http://127.0.0.1:$GENERIC_PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi

echo "✓ free-llm 安装完成。"
echo "  下一步：自检  node $HERE/test/test-e2e.mjs"
echo "  要退出：bash $HERE/uninstall.sh"
