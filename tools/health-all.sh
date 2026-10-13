#!/usr/bin/env bash
# health-all.sh — 一次性查看所有 multi-proxy 代理端口 + launchd 托管状态 + /health 抽样
# 用法：bash tools/health-all.sh
set -u
PORTS=(18790 18791 18792 18793 18794 18795 18796 18797)
NAMES=(codex-proxy ? manager hermes cursor ? savings-gateway dsh-lane)

echo "=== 端口监听 ==="
for i in "${!PORTS[@]}"; do
  p="${PORTS[$i]}"; n="${NAMES[$i]}"
  if lsof -ti :"$p" >/dev/null 2>&1; then
    pid="$(lsof -ti :"$p" | tr '\n' ' ')"
    printf "  :%-5s %-15s LISTENING (pid %s)\n" "$p" "$n" "$pid"
  else
    printf "  :%-5s %-15s down\n" "$p" "$n"
  fi
done

echo "=== launchd 托管 ==="
if launchctl list 2>/dev/null | grep -q multi-proxy; then
  launchctl list | grep multi-proxy
else
  echo "  (无 multi-proxy 在 launchd — 代理均为手动/非托管启动)"
fi

echo "=== /health 抽样（仅对监听中的网关类端口）==="
for p in 18790 18792 18793 18795 18796; do
  if lsof -ti :"$p" >/dev/null 2>&1; then
    printf "  :%s -> " "$p"
    body="$(curl -s -m 2 127.0.0.1:"$p"/health 2>/dev/null | head -c 160)"
    [ -n "$body" ] && echo "$body" || echo "(无 /health)"
  fi
done
echo "=== 完成 ==="
