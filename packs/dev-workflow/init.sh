#!/usr/bin/env bash
# packs/dev-workflow/init.sh — dev-workflow pack P0 init 脚本
#
# 一键完成 `docs/06-methodology/DEV-WORKFLOW-SPEC-draft-*.md` §八四步初始化：
# 1. 拷规范模板（去项目专属段）到新项目 docs/
# 2. 生成 `docs/QUEUE.md` 空骨架（INBOX / TASKS / DECISIONS）
# 3. `bd init --non-interactive --stealth --prefix <ASCII名>`
# 4. 检测 AGENTS.md / CLAUDE.md，幂等插入必读前置两行
#
# 用法：
#   cd /path/to/project && bash <(curl -s https://.../init.sh) [选项]
#   # 或本地调用：
#   bash packs/dev-workflow/init.sh --source /abs/path/to/DEV-WORKFLOW-SPEC.md
#
# ⚠️ 两个已实测坑：
#   ① 目录名含中文必须加 `--prefix <纯ASCII名>`
#   ② 首次 init 失败残留 `.beads/embeddeddolt`，重装前先 `rm -rf .beads`

set -euo pipefail

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(pwd)"
SPEC_SRC=""        # 规范源文件路径（默认从仓库拷）
TARGET_DIR=""      # 目标项目 docs/ 目录
PREFIX=""          # bd init prefix（默认从目录名派生，去非 ASCII）
DRY_RUN=0          # --dry-run 模式只打印不执行

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)  SPEC_SRC="$2"; shift 2 ;;
    --target)  TARGET_DIR="$2"; shift 2 ;;
    --prefix)  PREFIX="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) bash "$SCRIPT_DIR/init.sh" --help; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ─── 工具函数 ─────────────────────────────────────────────────────────────────
log()   { echo "[dev-workflow] $*"; }
warn()  { echo "[dev-workflow] WARN: $*" >&2; }
die()   { echo "[dev-workflow] ERROR: $*" >&2; exit 1; }

# 幂等检查 marker：在目标文件内搜索已插入内容的特征词（防重复插入）
has_marker() {
  local file="$1" marker="$2"
  grep -qF "$marker" "$file" 2>/dev/null
}

# 幂等插入：在目标文件指定 marker 后插入行（若已插入则跳过）
# 注意：has_marker 查的是**新内容的特征词**（如 'bd ready'），
# 不是 marker 标题本身——否则任何已有 '## 0 · 必读前置' 的文件都会跳过插入。
insert_after_marker() {
  local file="$1" title_marker="$2" insert_content="$3" unique_marker="$4"
  if has_marker "$file" "$unique_marker"; then
    log "  ✓ $file 已含 ${unique_marker}，跳过插入（幂等）"
    return 0
  fi
   # 多行内容经临时文件传，规避 awk -v 参数无法承载换行的坑（newline in string）
  local newf; newf=$(mktemp)
  printf '%s\n' "$insert_content" > "$newf"
  local tmp; tmp=$(mktemp)
  awk -v title="$title_marker" -v newf="$newf" '
      { print }
    index($0, title) {
      while (getline line < newf > 0) printf "%s\n", line
      close(newf)
    }
   ' "$file" > "$tmp" && mv "$tmp" "$file"
   rm -f "$newf"
  log "  ✓ 已在 $title_marker 后插入到 $file"
}

# ─── Step 0：前置检查 ──────────────────────────────────────────────────────────
log "Step 0 · 前置检查"

if ! command -v bd &>/dev/null; then
  die "bd (beads) 未安装，请先 brew install beads"
fi

if [[ -z "$SPEC_SRC" ]]; then
  # 默认从本仓库拷模板（假设脚本在 multi-proxy 仓内被调用）
  SPEC_SRC="$HOME/Documents/AI项目/agent-infra/methodology/DEV-WORKFLOW-SPEC-draft-2026-10-01.md"
  if [[ ! -f "$SPEC_SRC" ]]; then
    die "找不到规范源文件: $SPEC_SRC"
  fi
fi

# 目标 docs/ 目录
if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$PROJECT_ROOT/docs"
fi
mkdir -p "$TARGET_DIR"

# prefix 默认从目录名派生（取第一个纯 ASCII 段）
if [[ -z "$PREFIX" ]]; then
  dir_name="$(basename "$PROJECT_ROOT")"
  # 去掉非 ASCII 部分，取首段
  PREFIX=$(echo "$dir_name" | sed -E 's/[^a-zA-Z0-9].*//' | tr '[:upper:]' '[:lower:]')
  [[ -z "$PREFIX" ]] && PREFIX="project"
  log "  prefix 自动派生: $PREFIX"
fi

log "  规范源: $SPEC_SRC"
log "  目标:     $TARGET_DIR"
log "  prefix: $PREFIX"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "    [dry-run] 计划执行（不写盘）："
  log "    1. 拷规范模板 → $TARGET_DIR/06-methodology/DEV-WORKFLOW-SPEC-draft-$(date +%Y-%m-%d).md"
  log "    2. 建 QUEUE.md 骨架 → $TARGET_DIR/QUEUE.md"
  log "    3. bd init --non-interactive --stealth --prefix $PREFIX"
  log "    4. 幂等插必读前置 → AGENTS.md / CLAUDE.md"
  exit 0
fi

# ─── Step 1：拷规范模板 ─────────────────────────────────────────────────────────
log "Step 1 · 拷规范模板（去项目专属段）"

SPEC_DST="$TARGET_DIR/06-methodology/DEV-WORKFLOW-SPEC-draft-$(date +%Y-%m-%d).md"
mkdir -p "$(dirname "$SPEC_DST")"

# 复制并删除 multi-proxy 专属段（§3.6 遗留问题收编，仅列本项目 TK 条目）
# 用 awk 行区间（### 3.6 起，到下一个 ## 级标题前），比 sed ,/^---$/ 稳——
# 本规范 §3.6 后跟 ## 四，无 --- 分隔，sed 行区间会找不到终止符。
awk '
  /^### 3\.6/            { skip=1 }
  /^## / && skip         { skip=0 }
  !skip                  { print }
' "$SPEC_SRC" > "$SPEC_DST"

# 替换标题日期为当前日期
NEW_DATE=$(date +%Y-%m-%d)
sed -i '' "s/v0，已批准试行两周/v0，新安装·$(date +%Y-%m-%d)/" "$SPEC_DST"
sed -i '' "s/2026-10-01 sifa 拍板/新安装 拍板/" "$SPEC_DST"

log "  ✓ 写到 $SPEC_DST"

# ─── Step 2：建 QUEUE.md 空骨架 ────────────────────────────────────────────────
log "Step 2 · 建 QUEUE.md 空骨架"

QUEUE_DST="$TARGET_DIR/QUEUE.md"
if [[ -f "$QUEUE_DST" ]]; then
  warn "  $QUEUE_DST 已存在，跳过（保留原内容）"
else
  cat > "$QUEUE_DST" <<EOF
# $QUEUE_DST — 任务队列（$(date +%Y-%m-%d) 建立）

> 依据 \`docs/06-methodology/DEV-WORKFLOW-SPEC-draft-${NEW_DATE}.md\` §三 建。
> 格式：INBOX / TASKS / DECISIONS 三段。每段条目见 \`bd list\` 或本文件。

---

## INBOX

> 来源：外部调研/洞察入口。agent 读后决定是否搬入 TASKS 或 DECISIONS。

（空，等待首批条目）

---

## TASKS

### 活跃任务（in_progress / ready）

| ID | 标题 | 状态 | 优先级 | 认领时间 | DoD 证据位置 |
|----|------|------|--------|----------|--------------|
（暂无）

### 历史任务（closed / done）

| ID | 标题 | 状态 | 关闭时间 | DoD 证据 |
|----|------|------|----------|----------|
（暂无）

---

## DECISIONS

> 来源：拍板指令 / 规范试行期异议提案。格式：标题 + 拍板结论 + 拍板时间 + 依据。
> 本段只由拍板驱动，agent 不自主决策。

（暂无）

---
EOF
  log "  ✓ 写到 $QUEUE_DST"
fi

# ─── Step 3：装 beads ─────────────────────────────────────────────────────────
log "Step 3 · bd init（stealth 模式，prefix=${PREFIX}）"

if [[ -d "$PROJECT_ROOT/.beads" ]]; then
  # 检测是否有残留 embeddeddolt（首次 init 失败的标志）
  if [[ -d "$PROJECT_ROOT/.beads/embeddeddolt" ]]; then
    warn "  检测到残留 .beads/embeddeddolt，先清理再 init"
    rm -rf "$PROJECT_ROOT/.beads"
  fi
fi

bd init --non-interactive --stealth --prefix "$PREFIX" 2>&1 || {
  warn "  bd init 失败，请检查 beads 安装状态"
  exit 1
}
log "   ✓ .beads/ 已 init（prefix=${PREFIX}）"

# ─── Step 4：接必读路径 ───────────────────────────────────────────────────────
log "Step 4 · 接必读路径（AGENTS.md / CLAUDE.md）"

MARKER="## 0 · 必读前置"
INSERT_LINES="**开发任务（$(date +%Y-%m-%d) 起）**：先 \`bd ready\` 认领活（beads 任务队列，stealth 模式），并遵守
\`docs/06-methodology/DEV-WORKFLOW-SPEC-draft-${NEW_DATE}.md\`（流程规范：会话协议开场三读/收尾三写、DoD 四要件、按文件单写者）。"

for agent_file in AGENTS.md CLAUDE.md; do
  if [[ -f "$PROJECT_ROOT/$agent_file" ]]; then
    insert_after_marker \
       "$PROJECT_ROOT/$agent_file" \
       "$MARKER" \
       "$INSERT_LINES" \
       "bd ready"
  else
    log "  ○ $agent_file 不存在，跳过"
  fi
done

# ─── 收尾 ──────────────────────────────────────────────────────────────────────
log ""
log "✅ dev-workflow pack P0 init 完成"
log "  规范模板: $SPEC_DST"
log "  任务队列: $QUEUE_DST"
log "  beads:    $PROJECT_ROOT/.beads/"
log ""
log "下一步：\`bd ready\` 查看待办，\`bd create "新任务标题" --description "描述"\` 开工"
