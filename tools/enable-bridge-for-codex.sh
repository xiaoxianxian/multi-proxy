#!/usr/bin/env bash
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
#
# 把 Codex 的 base_url 从 18790（直连 codex-proxy）切到 18795（token-policy-bridge），
# 让流量经过已装好的上游熔断器（BRIDGE_CIRCUIT_BREAKER=recommended / MODE=observe）。
#
# 为什么需要脚本而不是 agent 直接改：
#   agent 沙箱内 `launchctl load/bootstrap` 一律失败（Load failed: 5: Input/output error），
#   手动起的长驻进程也会被沙箱清理 ⇒ agent 无法保证 18795 常驻。
#   若 bridge 不在就把 Codex 指过去，Codex 会直接连不上 ⇒ 必须在同一个能管 launchd 的
#   会话里「先确保 bridge 常驻、再改配置」，且任何一步失败立即回滚。
#
# 用法：
#   bash tools/enable-bridge-for-codex.sh              # 启用（bridge 18795）
#   bash tools/enable-bridge-for-codex.sh --rollback   # 回滚（指回 18790）
#
# 设计：observe 模式只记账不拦请求，最坏情况只是多一跳；出问题随时 --rollback。

set -uo pipefail

MP="/Users/xiaota/Documents/AI项目/multi-proxy"
PLIST="$HOME/Library/LaunchAgents/com.multi-proxy.token-policy-bridge.plist"
CODEX="$HOME/.codex/config.toml"
BACKUP="$CODEX.bak-2026-10-08"
LABEL="com.multi-proxy.token-policy-bridge"
FROM_URL="http://127.0.0.1:18790/v1"
TO_URL="http://127.0.0.1:18795/v1"

# ---------- 回滚 ----------
if [ "${1:-}" = "--rollback" ]; then
  echo "↩️  回滚：Codex base_url → $FROM_URL"
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$CODEX" && echo "   ✅ 已从备份恢复 $CODEX"
  else
    echo "   ⚠️  备份 $BACKUP 不存在，改用原地替换"
    sed -i '' "s|base_url = \"$TO_URL\"|base_url = \"$FROM_URL\"|g" "$CODEX"
  fi
  grep -n 'base_url' "$CODEX" | sed 's/^/   /'
  echo "   重启 Codex 生效。"
  exit 0
fi

# ---------- 0. 前置检查 ----------
[ -f "$PLIST" ] || { echo "❌ 找不到 $PLIST"; exit 1; }
[ -f "$CODEX" ] || { echo "❌ 找不到 $CODEX"; exit 1; }

echo "=== 0/4 前置检查 ==="
plutil -lint "$PLIST" >/dev/null 2>&1 && echo "   ✅ plist 合法" || { echo "   ❌ plist 非法"; exit 1; }

# ---------- 1. 确保 bridge 常驻 ----------
echo "=== 1/4 确保 bridge(18795) 常驻 ==="
if curl -s --noproxy '*' -m 3 "http://127.0.0.1:18795/health" >/dev/null 2>&1; then
  echo "   ✅ 18795 已在监听"
else
  echo "   → 未监听，launchctl load ..."
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load "$PLIST" 2>&1 | sed 's/^/     /'
fi

# 轮询等待就绪（最多 15s）
OK=0
for i in $(seq 1 15); do
  if curl -s --noproxy '*' -m 3 "http://127.0.0.1:18795/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "   ❌ 18795 起不来，放弃切换（Codex 保持 $FROM_URL 不动）"
  echo "      排查：launchctl list | grep $LABEL ; tail logs/token-policy-bridge.launchd.err.log"
  exit 1
fi
echo "   ✅ 18795 就绪"

# ---------- 2. 确认熔断门控已生效 ----------
echo "=== 2/4 确认熔断门控 ==="
HEALTH=$(curl -s --noproxy '*' -m 3 "http://127.0.0.1:18795/health" 2>/dev/null)
echo "$HEALTH" | grep -q '"enabled":true' \
  && echo "   ✅ circuit 已启用：$(echo "$HEALTH" | python3 -c 'import sys,json;c=json.load(sys.stdin).get("circuit",{});print("mode="+str(c.get("mode")),"state="+str(c.get("state")))' 2>/dev/null)" \
  || { echo "   ⚠️  circuit 未启用（BRIDGE_CIRCUIT_BREAKER 未注入），继续但不带熔断保护"; }

# ---------- 3. 备份 + 切换 base_url ----------
echo "=== 3/4 切换 Codex base_url ==="
[ -f "$BACKUP" ] || cp "$CODEX" "$BACKUP"
echo "   ✅ 备份 → $BACKUP"

if grep -q "base_url = \"$TO_URL\"" "$CODEX"; then
  echo "   ✅ 已经是 $TO_URL，无需改动"
else
  sed -i '' "s|base_url = \"$FROM_URL\"|base_url = \"$TO_URL\"|g" "$CODEX"
  grep -q "base_url = \"$TO_URL\"" "$CODEX" \
    && echo "   ✅ 已切到 $TO_URL" \
    || { echo "   ❌ 切换失败，回滚"; cp "$BACKUP" "$CODEX"; exit 1; }
fi
grep -n 'base_url' "$CODEX" | sed 's/^/   /'

# ---------- 4. 链路验证 ----------
echo "=== 4/4 链路验证（假 key，预期透传上游 401 ⇒ 证明链路通）==="
CODE=$(curl -s --noproxy '*' -m 8 -o /tmp/_bridge_probe_body -w '%{http_code}' \
  -X POST "http://127.0.0.1:18795/v1/chat/completions" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer probe-fake-key' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":8}' 2>/dev/null)
echo "   HTTP $CODE"
if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
  echo "   ❌ 链路不通，回滚 Codex 配置"
  cp "$BACKUP" "$CODEX"
  exit 1
fi
echo "   ✅ 链路通（上游对假 key 的响应已透传回来）"

echo
echo "🎉 完成。请重启 Codex 让新 base_url 生效。"
echo "   · 观察熔断：curl --noproxy '*' http://127.0.0.1:18795/health  （看 circuit.state / failureCount）"
echo "   · 观察记账：$MP/logs/token-policy-bridge-\$(date +%F).jsonl"
echo "   · 回滚：bash $MP/tools/enable-bridge-for-codex.sh --rollback"
