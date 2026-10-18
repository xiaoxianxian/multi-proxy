#!/usr/bin/env bash
# multi-proxy 轻档镜像 MVP · 冒烟判据
# build + up + 探活（manager / 本地 Ollama）+ h3web 探针 precheck（可选）
# 用法：./scripts/lite-mvp-smoke.sh
set -e
cd "$(dirname "$0")/.."

echo "=== [1/4] build + up 轻档（manager + L2 h3web，接本地 Ollama）==="
docker compose -f docker-compose.lite-mvp.yml up -d --build
sleep 6

echo ""
echo "=== [2/4] manager 探活 :18792 ==="
if curl -sf http://localhost:18792/ >/dev/null 2>&1; then
  echo "  ✓ manager UP"
else
  echo "  ✗ manager DOWN"; docker compose -f docker-compose.lite-mvp.yml logs --tail=30
fi

echo ""
echo "=== [3/4] 本地 Ollama 探活 :11434（轻档接本地引擎）==="
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "  ✓ Ollama UP"; curl -sf http://localhost:11434/api/tags | head -c 200; echo
else
  echo "  ⚠ Ollama DOWN（轻档可跑但本地引擎未接；接 :11434 才有本地算力）"
fi

echo ""
echo "=== [4/4] h3web 探针 precheck（仅当 :8731 在听才跑；轻档默认不带 h3 重引擎）==="
if lsof -iTCP:8731 -sTCP:LISTEN >/dev/null 2>&1; then
  node scripts/h3web-roundtrip-probe.js --precheck || true
else
  echo "  ⚠ h3web :8731 未监听 → 跳过（重量档再起 h3 引擎；轻档 = Ollama 27B + 调度层 + 判据）"
fi

echo ""
echo "=== 判据 ==="
echo "  轻档 GO 判据 = manager UP 且 本地 Ollama UP（h3web precheck 可选）。"
echo "  重量档另开：PROXY_H3WEB_AUTOSTART=1 + 起 h3 引擎（h3web.py / h3_bridge.py）后跑 --precheck GO。"
