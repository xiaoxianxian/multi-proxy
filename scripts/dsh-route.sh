#!/usr/bin/env bash
# dsh-route.sh — 把 DeepSeek Harness (DSH) 桌面端的默认模型接到本地底座 18790。
#
#   ./dsh-route.sh on     接入（备份 + 改配置 + 起底座 + 自检）
#   ./dsh-route.sh off    还原到改动前（配置），底继续由 manage.sh 管
#   ./dsh-route.sh check  只自检，不动任何文件
#
# 可逆性：改前各备份一份到 ~/.dsh/**/*.bak-<stamp>；off 用备份整份还原。
# 每次 on 都会改完自动起底座并在 CLI 侧实发一次请求做端到端自检。

set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
PATCH="$PROFILE_DIR/cordis.patch.yml"
SETTINGS="$DSH_HOME/settings.yaml.imported"
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PROXY_DIR="$HOME/Documents/AI项目/multi-proxy"
BASE="http://127.0.0.1:18790/v1"
TS="$(date +%Y%m%d-%H%M%S)"
STAMP="$TS"

log() { printf '%s\n' "$*"; }

# ---------- 自检 ----------

# 底座是否活着。底座是外部进程，DSH 桌面端不带底座。
base_up() {
  [ "$(curl -s --noproxy '*' -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:18790/health)" = "200" ]
}

start_base() {
  if base_up; then
    log "底座 18790：已在运行"
    return 0
  fi
  log "底座 18790：未运行，执行 manage.sh start codex ..."
  (cd "$PROXY_DIR" && bash ./manage.sh start codex) >/dev/null 2>&1 || true
  sleep 2
  base_up && log "底座 18790：已启动" || { log "底座 18790：启动失败，检查 multi-proxy 是否安装了 codex 底座"; return 1; }
}

self_test() {
  log "--- 端到端自检（CLI 侧实发一次真实请求）---"
  local out
  out=$("$DSH_BIN" headless --patch "$PATCH" "只回两个字：好嘞" 2>&1 | grep -v "ERROR:electron" | tail -2)
  log "$out"
  if printf '%s' "$out" | grep -q "Connection error\|No API key"; then
    log "自检结果：失败（上面对照底座状态看是哪一端的问题）"
    return 1
  fi
  log "自检结果：通过"
  return 0
}

# ---------- on ----------

do_on() {
  # 配置 A：profile patch（主生效源）。
  # 只改 agnes 的 baseURL 和默认模型两处，其余段落（ui-chat / ui-settings-*
  # 等你自己调的界面设置）原样保留——整份重写会抹掉它们。
  [ -f "$PATCH" ] || { log "找不到 ${PATCH}，DSH 桌面端 profile 不存在"; exit 1; }
  cp "$PATCH" "$PATCH.bak-$STAMP"
  # 按缩进层级判断「段」的边界：段的下一行缩进 <= 段头缩进才算离开。
  # 不能用「任何非空非注释行就退出」——那样 agnes 段内的第一行
  # apiKeyEnv: 就会把标记清掉，baseURL 永远轮不到。
  awk -v base="$BASE" '
    {
      if ($0 ~ /^[[:space:]]*agnes:[[:space:]]*$/) {
        match($0, /^[[:space:]]*/); depth = RLENGTH; ina = 1; print; next
      }
      if (ina) {
        match($0, /^[[:space:]]*/)
        if (RLENGTH <= depth) ina = 0
        else if ($0 ~ /^[[:space:]]*baseURL:/) { print "        baseURL: " base; next }
      }
      print
    }
  ' "$PATCH" > "${PATCH}.tmp" && mv "${PATCH}.tmp" "$PATCH"
  awk '
    {
      if ($0 ~ /^[[:space:]]*agent-default-model[[:space:]]*$/) {
        match($0, /^[[:space:]]*/); depth = RLENGTH; inm = 1; print; next
      }
      if (inm) {
        match($0, /^[[:space:]]*/)
        if (RLENGTH <= depth) inm = 0
        else if ($0 ~ /^[[:space:]]*provider:/) { print "    provider: agnes"; next }
        else if ($0 ~ /^[[:space:]]*model:/)    { print "    model: agnes-3.0-flash"; next }
      }
      print
    }
  ' "$PATCH" > "${PATCH}.tmp" && mv "${PATCH}.tmp" "$PATCH"
  log "配置已改：[A] ${PATCH}（agnes.baseURL → ${BASE}；默认模型 → agnes / agnes-3.0-flash）"

  # 配置 B：导入的设置快照。agnes 有两份拷贝，只改 patch 盖不住这一份。
  if [ -f "$SETTINGS" ]; then
    cp "$SETTINGS" "$SETTINGS.bak-$STAMP"
    awk -v base="$BASE" '
      {
        if ($0 ~ /^[[:space:]]*agnes:[[:space:]]*$/) {
          match($0, /^[[:space:]]*/); depth = RLENGTH; ina = 1; print; next
        }
        if (ina) {
          match($0, /^[[:space:]]*/)
          if (RLENGTH <= depth) ina = 0
          else if ($0 ~ /^[[:space:]]*baseURL:/) { print "      baseURL: " base; next }
        }
        print
      }
    ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
    log "配置已改：[B] ${SETTINGS}（agnes 段 baseURL → ${BASE}）"
  else
    log "配置 B：跳过，$SETTINGS 不存在"
  fi

  # 底座 + 自检
  start_base || exit 1
  self_test
  log
  log "接入完成。DSH 桌面端必须完全退出再打开（Cmd+Q，不是关窗口）才会吃到新配置。"
  log "还原：./dsh-route.sh off"
}

# ---------- off ----------

do_off() {
  # 取「最新的一份备份」整份还原。备份名是 on 那一刻的时间戳，
  # 用当前时刻再拼 STAMP 是找不到的。
  local restored=0 pb sb
  pb="$(ls -t "${PATCH}".bak-* 2>/dev/null | head -1)"
  sb="$(ls -t "${SETTINGS}".bak-* 2>/dev/null | head -1)"
  if [ -n "$pb" ] && [ -f "$pb" ]; then
    mv "$pb" "$PATCH"; log "已还原：${PATCH}（来自 ${pb}）"; restored=1
  fi
  if [ -n "$sb" ] && [ -f "$sb" ]; then
    mv "$sb" "$SETTINGS"; log "已还原：${SETTINGS}（来自 ${sb}）"; restored=1
  fi
  if [ "$restored" = 1 ]; then
    log "还原完成。然后 Cmd+Q 重开 DSH 桌面端。"
  else
    log "没找到本次会话的备份（${PATCH}.bak-${STAMP} / ${SETTINGS}.bak-${STAMP}），无需还原。"
  fi
}

# ---------- check ----------

do_check() {
  if base_up; then log "底座 18790：运行中"; else log "底座 18790：未运行（DSH 桌面端不带底座，需先起）"; fi
  log "--- 合成配置树里的真正生效值 ---"
  "$DSH_BIN" --profile web --patch "$PATCH" --dump-config 2>/dev/null \
    | grep -A3 -E "^[[:space:]]*agnes:" | head -6
  log "--- 默认模型（决定 GUI 里发话用谁）---"
  "$DSH_BIN" --profile web --patch "$PATCH" --dump-config 2>/dev/null \
    | grep -A3 -E "agent-default-model" | head -5
  self_test
}

case "${1:-on}" in
  on)      do_on ;;
  off)     do_off ;;
  check)   do_check ;;
  *)       log "用法: $0 [on|off|check]"; exit 1 ;;
esac
