#!/usr/bin/env bash
# 推送 multi-proxy-lite 到渠道。
# 默认 dry-run：只校验（镜像存在/大小/仓库名格式/tag），不真推。
# 真推需加 --push（推公网=不可逆，按 4.6 红线需老板 signoff + 仓库账号）。
# 用法：
#   校验：  bash scripts/push-lite-mvp.sh <owner-repo>
#   真推：  bash scripts/push-lite-mvp.sh <owner-repo> --push
# 例：  bash scripts/push-lite-mvp.sh docker.io/jason/multi-proxy-lite --push
# 前置：本地已 docker build -t multi-proxy-lite:1.0 -f Dockerfile.lite-mvp .
set -euo pipefail
cd "$(dirname "$0")/.."
OWNERREPO="${1:?用法：bash scripts/push-lite-mvp.sh <owner-repo> [--push]}"
TAG="1.0"
MODE="dry-run"; if [ "${2:-}" = "--push" ]; then MODE="push"; fi

echo "=== multi-proxy-lite push 校验 (MODE=$MODE) ==="
echo "目标仓库：$OWNERREPO:$TAG"

# 1. 本地镜像存在 + 大小核对
if docker image inspect "multi-proxy-lite:$TAG" >/dev/null 2>&1; then
   SIZE=$(docker image inspect "multi-proxy-lite:$TAG" --format '{{.Size}}')
   echo "[OK] 本地 multi-proxy-lite:$TAG 存在，大小约 $(( SIZE / 1024 / 1024 )) MB"
else
   echo "[FAIL] 本地无 multi-proxy-lite:$TAG —— 先：docker build -t multi-proxy-lite:$TAG -f Dockerfile.lite-mvp ."
   exit 1
fi

# 2. 仓库名格式校验（docker 仓库须含 owner/repo）
case "$OWNERREPO" in
    */*) ;;
    *) echo "[FAIL] 仓库名须含 owner/repo（如 docker.io/jason/multi-proxy-lite），你传的是 $OWNERREPO"; exit 1 ;;
esac
echo "[OK] 仓库名格式合法：$OWNERREPO"

# 3. tag 校验
echo "[OK] tag=${TAG}（与本地镜像一致）"
echo "----- 校验通过 -----"

if [ "$MODE" = "push" ]; then
   echo "→ 开始真推（不可逆）：docker tag + 推送"
   docker tag "multi-proxy-lite:$TAG" "$OWNERREPO:$TAG"
   echo "→ 推送中（约 577MB，可能数分钟）..."
   docker push "$OWNERREPO:$TAG"
   echo "[OK] 已推 $OWNERREPO:$TAG；验证 docker pull $OWNERREPO:$TAG；国内拉取慢可另建 ACR/腾讯云源双推"
else
   echo "[dry-run] 未真推。确认无误后执行真推：bash scripts/push-lite-mvp.sh $OWNERREPO --push"
fi
