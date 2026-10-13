#!/bin/bash
# multi-proxy 本地「安装使用版」更新器
#
# 目的：维护者要求（2026-10-05）——multi-proxy 有较大更新时，把本地实际在用的那份
# 更新成最新，让测试跑在「真装上」的版本上，别出现「测的是 A、用的是 B」的 gap。
#
# 本地实际在用的三处落点：
#   1. 源码目录                 = 底座运行源（客户端起 node proxy.js 时直接用这个目录，无副本）
#   2. ~/Applications/MultiProxy.app = 客户端，唯一需要单独构建安装的产品
#   3. ~/.dsh/skills/multi-proxy     = 仓库内 .dsh/skills/ 的同步落点（改了要一起带上）
#
# 用法：
#   bash scripts/update-local.sh            # 只体检：fetch + 报告差多少 + 能不能 apply（无任何副作用）
#   bash scripts/update-local.sh --apply    # 真更新（默认关，见下方四道闸门）
#   bash scripts/update-local.sh --revert   # 回到上一次 apply 之前的 HEAD 并重建
#
# 闸门（任一不满足就只报告、绝不动手）：
#   G1 上游有新提交，且被判为「大更新」（动了运行时代码）
#   G2 工作区干净（仓库里可能有别的会话正在途改动，不能替别人做决定）
#   G3 本地没有未推送的提交（否则没法 fast-forward）
#   G4 pull 必须是 --ff-only，非快进直接放弃
#
# 回滚：apply 前把 HEAD 记进 ~/.multi-proxy-last-apply，--revert 据此 reset。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/Applications/MultiProxy.app"
CLIENT_BUILD="$REPO/client/build/MultiProxy.app"
LOG="$HOME/Library/Logs/MultiProxy-client.log"
STATE="$HOME/.multi-proxy-last-apply"
HEALTH_URL="http://127.0.0.1:18790/health"
# 只动这些目录/扩展名 = 小更新（文档、测试、CI、公式）；其余一律算大更新
SMALL_PATTERN='^(docs|\.github|\.dsh/skills)/|(\.md|\.mdx|\.txt|\.lock)$'

log() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "❌ $*"; exit 1; }

# macOS 没有 etimes；这里只用 pgrep 取 pid，不解析时间
dsh_pids() { pgrep -f 'Contents/MacOS/DeepSeek Harness' 2>/dev/null; }
base_pids() { pgrep -f 'codex-proxy/proxy.js' 2>/dev/null; pgrep -f 'proxy.js' 2>/dev/null | sort -u; }

# 起底座：和客户端同一个姿势（干净 env + cwd=codex-proxy + detached），别走管道
start_base() {
  local node="$HOME/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"
  [ -x "$node" ] || node="$(command -v node || true)"
  [ -n "$node" ] || { log "⚠️ 找不到 node，跳过底座重启"; return 1; }
  ( cd "$REPO/codex-proxy" && exec nohup "$node" proxy.js >/dev/null 2>&1 & )
  local waited=0
  while [ "$waited" -lt 30 ]; do
    if [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL")" = "200" ]; then
      log "   底座已起（health 200，等 ${waited}s）"; return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  log "   ⚠️ 等了 ${waited}s 没等到 health 200，底座可能没起来"; return 1
}

# 原地替换客户端二进制（整体 cp -R 覆盖 Applications 会触发删除拦截并留 .cstemp）
install_client() {
  [ -d "$CLIENT_BUILD" ] || { log "⚠️ 找不到 $CLIENT_BUILD"; return 1; }
  local bin="$CLIENT_BUILD/Contents/MacOS/MultiProxy" dst="$APP/Contents/MacOS/MultiProxy"
  [ -f "$bin" ] || { log "⚠️ 构建产物里没有 MultiProxy 可执行文件"; return 1; }
  mkdir -p "$APP/Contents/MacOS"
  [ -f "$dst" ] && cp "$dst" "$STATE.dst-bak" 2>/dev/null
  cp "$bin" "$dst" || { log "⚠️ 原地替换失败（可能在受保护目录）"; return 1; }
  codesign --force --sign - "$dst" >/dev/null 2>&1
  xattr -cr "$dst" 2>/dev/null
  codesign -vv "$APP" >/dev/null 2>&1 && log "   客户端已原地替换并签名 OK" || log "   ⚠️ 客户端已替换，但签名校验没过"
  return 0
}

rebuild_client() {
  log "  · 重建客户端（build.sh）"
  ( cd "$REPO/client" && bash ./build.sh >/dev/null 2>&1 ) && install_client
}

# ---------- 体检 ----------
fetch_and_probe() {
  log "== 1) fetch =="
  git -C "$REPO" fetch --quiet origin 2>/dev/null || log "   （fetch 报错也继续看本地信息）"
  local local_head upstream local_ahead upstream_ahead
  local_head="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
  upstream="$(git -C "$REPO" rev-parse origin/main 2>/dev/null)" || upstream=""
  # A...B 的左列＝只在 A 的提交，右列＝只在 B 的提交；这里 A=本地 B=上游
  local_ahead="$(git -C "$REPO" rev-list --count --left-right "${local_head}...origin/main" 2>/dev/null | awk '{print $1}')"
  upstream_ahead="$(git -C "$REPO" rev-list --count --left-right "${local_head}...origin/main" 2>/dev/null | awk '{print $2}')"
  log "   HEAD          = ${local_head:0:8}  ($(git -C "$REPO" log -1 --format='%s' 2>/dev/null | cut -c1-60))"
  log "   本地未推送    = ${local_ahead:-?} 个"
  log "   上游未拉取    = ${upstream_ahead:-?} 个"

  if [ -z "$upstream" ] || [ "$upstream" = "$local_head" ]; then
    log "   → 已是最新，没有可拉的东西"; return 1
  fi
  if [ "${upstream_ahead:-0}" -le 0 ]; then
    log "   → 上游没有新提交（本地领先，未推送的提交才是重点）"; return 1
  fi

  log "== 2) 新提交清单 =="
  git -C "$REPO" log --oneline "${local_head}..origin/main" 2>/dev/null | head -10

  log "== 3) 大/小更新判定 =="
  local files hits
  files="$(git -C "$REPO" diff --name-only "${local_head}..origin/main" 2>/dev/null)"
  hits="$(printf '%s\n' "$files" | grep -vE "$SMALL_PATTERN" | grep -c .)"
  if [ "${hits:-0}" -gt 0 ]; then
    log "   → 判定：**大更新**（动了运行时代码，${hits} 个文件）"
  else
    log "   → 判定：小更新（只有文档/测试/CI 类改动），按规矩不动手"
    return 1
  fi

  log "== 4) apply 前置闸门 =="
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    log "   ❌ G2 工作区不干净，有在途改动（不能替别人做决定）："
    git -C "$REPO" status --short 2>/dev/null | head -8 | sed 's/^/       /'
    return 1
  fi
  log "   ✅ G2 工作区干净"
  if [ "${local_ahead:-0}" -gt 0 ]; then
    log "   ❌ G3 本地有 ${local_ahead} 个未推送提交，无法 fast-forward"
    log "      按规矩（push 要维护者 验收）这里不推，请维护者决定：先 push 或先处理"
    return 1
  fi
  log "   ✅ G3 本地无未推送提交"
  return 0
}

# ---------- 主流程 ----------
case "${1:---check}" in
  --check|"")
    log "=== multi-proxy 本地更新体检（只读，无副作用）==="
    if fetch_and_probe; then
      log ""
      log "✅ 可以 apply。执行： bash $0 --apply"
    else
      log ""
      log "本次不更新（上方已说明原因）。跑过 apply 的闸门后结果才一样。"
    fi
    ;;
  --apply)
    log "=== 开始更新本地安装使用的 multi-proxy ==="
    fetch_and_probe || fail "闸门没过，已停止，没动任何东西"
    log ""
    log "== 5) 拉代码 =="
    PREV="$(git -C "$REPO" rev-parse HEAD)"
    echo "$PREV $(date '+%Y-%m-%d %H:%M:%S')" > "$STATE"
    git -C "$REPO" pull --ff-only origin main >/dev/null 2>&1 \
      || fail "pull --ff-only 失败（非快进或有冲突），已回滚意愿，工作区未动"
    log "   HEAD: ${PREV:0:8} → $(git -C "$REPO" rev-parse --short HEAD)"
    log ""
    log "== 6) 重建 + 安装客户端 =="
    rebuild_client
    log ""
    log "== 7) 重启底座（让当前会话就用上新代码）=="
    for p in $(base_pids); do kill "$p" 2>/dev/null; done
    sleep 2
    start_base
    log ""
    log "== 8) 校验 =="
    [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL")" = "200" ] \
      && log "✅ 底座 health 200" || log "❌ 底座没起来，看 ~/Library/Logs/MultiProxy-client.log"
    log "   DSH 进程数: $(dsh_pids | wc -l | tr -d ' ')"
    log "=============================================="
    log "更新完成。回滚： bash $0 --revert"
    ;;
  --revert)
    [ -f "$STATE" ] || fail "没有 $STATE，无从回滚"
    PREV="$(awk '{print $1}' "$STATE")"
    log "=== 回滚到 ${PREV:0:8} ==="
    git -C "$REPO" reset --hard "$PREV" >/dev/null 2>&1 || fail "reset 失败，工作区保持原样没动"
    log "   HEAD → $(git -C "$REPO" rev-parse --short HEAD)"
    rebuild_client
    for p in $(base_pids); do kill "$p" 2>/dev/null; done
    sleep 2; start_base
    [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL")" = "200" ] \
      && log "✅ 回滚后底座 health 200" || log "❌ 回滚后底座异常"
    ;;
  *)
    log "用法: bash $0 [--check|--apply|--revert]"; exit 1 ;;
esac
