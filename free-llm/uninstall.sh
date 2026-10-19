#!/usr/bin/env bash
# free-llm · 卸载：只移除 free-llm-* 条目，其它 provider 原样保留，不重启、不删数据
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/.multi-proxy-manager"
LIVE="$DATA_DIR/providers.json"

if [ ! -f "$LIVE" ]; then
  echo "live providers.json 不存在，无需卸载"; exit 0
fi
BACKUP="$LIVE.bak-$(date +%s)"
cp -p "$LIVE" "$BACKUP"
echo "· 已备份 → $BACKUP"

LIVE="$LIVE" node - <<'JS'
const fs = require('fs');
const f = process.env.LIVE;
const live = JSON.parse(fs.readFileSync(f, 'utf8'));
const before = live.length;
const keep = live.filter(p => !String(p.id || '').startsWith('free-llm-'));
fs.writeFileSync(f, JSON.stringify(keep, null, 2) + '\n');
try { fs.chmodSync(f, 0o600); } catch (_) {}
console.log(`· 移除 ${before - keep.length} 家 free-llm provider，保留 ${keep.length} 家（原样）`);
JS

echo "✓ free-llm 卸载完成（multi-proxy 核心 18799 未动，其它 provider 未动）"
