#!/usr/bin/env bash
# probe-upstream-keys.sh — 上游 key 体检（T6 0.1，2026-10-06 hermes）
#
# 用途：T6 M6 接真实路由的数据面体检。只读各 provider 的 /models 端点，
#   打印 HTTP 状态 + 是否活，不打印/落盘 key 明文（脱敏 last4）。
#
# 安全设计：
#   - api_key 仅在子进程内使用，绝不写入日志/输出（只打 last4）
#   - 纯只读：不写 DB、不改任何文件、不 launchctl setenv（ADR-0003 非侵入）
#   - 本地 ollama（127.0.0.1）不打 key；外部 provider 打 key（经系统代理 7897 如需）
#
# 用法：
#   bash scripts/probe-upstream-keys.sh
#   DB 路径可覆盖：PROBE_DB=/path/to/proxy.db bash scripts/probe-upstream-keys.sh
#
# 退出码：0 = 全部 200；非 0 = 有 provider 非 200（死 key），供 CI/cron 判断。

set -uo pipefail

DB="${PROBE_DB:-$PWD/cursor-proxy/data/proxy.db}"
[ -f "$DB" ] || { echo "FATAL: db not found: $DB" >&2; exit 2; }
command -v sqlite3 >/dev/null || { echo "FATAL: sqlite3 not found" >&2; exit 2; }
command -v curl    >/dev/null || { echo "FATAL: curl not found" >&2; exit 2; }

# 经系统代理（外部 API 需代理；本地 ollama 直连）。
# 注意：用 -x/--proxy 显式代理（macOS libcurl 对 HTTPS_PROXY env 变量偶发 000），
# 不要 setenv 全局——仅本脚本子进程内用。
PROXY="-x http://127.0.0.1:7897"
NO_PROXY_FLAG="--noproxy 127.0.0.1,localhost,::1"

echo "=== T6 0.1 上游 key 体检 @ $(date '+%Y-%m-%d %H:%M') ==="
echo "DB: $DB"
echo ""

# 逐个 enabled provider 探 /models。key 脱敏：只打 ${#key} 末 4 位长度，不打印明文。
fail=0
count=0
# 读 enabled=1 的 providers：name | base_url | api_key（制表符分隔，逐行）
while IFS=$'\t' read -r name base_url api_key; do
  [ -z "$name" ] && continue
  count=$((count + 1))
  # 末 4 位长度标记（非明文）
  keylen=${#api_key}
  local_hint=""
  case "$base_url" in
    http://127.0.0.1*|http://localhost*) local_hint="(本地·直连)" ;;
  esac
   # 本地直连 / 外部经 -x 系统代理（libcurl 对 HTTPS_PROXY env 偶发 000，统一走 -x）
  if [ -n "$local_hint" ]; then
    http=$(curl -sS -o /dev/null -w '%{http_code}' $NO_PROXY_FLAG \
         --max-time 12 "$base_url/models" 2>/dev/null || echo "000")
  else
    http=$(curl -sS -o /dev/null -w '%{http_code}' $PROXY \
         -H "Authorization: Bearer $api_key" --max-time 20 \
         "$base_url/models" 2>/dev/null || echo "000")
  fi
  status_tag="??"
  case "$http" in
    200) status_tag="OK   " ;;
    401|403) status_tag="DEAD " ;;   # key 失效
    404) status_tag="NOEND" ;;
    *) status_tag="WARN " ;;
  esac
  printf '%-18s %-34s HTTP %-3s %s %s\n' "$name" "${base_url:0:32}" "$http" "$status_tag" "$local_hint"
  [ "$http" = "200" ] || fail=1
done < <(sqlite3 -noheader -separator $'\t' "$DB" \
  "SELECT name, base_url, api_key FROM providers WHERE enabled=1 ORDER BY name;")

echo ""
echo "=== 汇总：$count 个 enabled provider，死 key（非 200）标记如上 ==="
[ "$fail" = "0" ] && echo "结果：全活" || echo "结果：有死 key（DEAD/401/403）——路由会撞 401，需处置（T6 拍 A）"
exit $fail
