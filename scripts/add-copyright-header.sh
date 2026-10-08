#!/usr/bin/env bash
# add-copyright-header.sh — DRY-RUN (默认关, 不执行)
# 用途: 批量给 multi-proxy 仓内 .js/.ts/.py/.md 加版权头
# 铁律: 默认只做 dry-run, 维护者说一句 "run" 才真改; git add -- 显式列文件
# 修复(2026-10-08): ① 去掉 header 里误带的 "#!/usr/bin/env bash"(会覆盖 .js/.cjs 的 node shebang)
#                   ② 文件首行是 shebang 时, 版权头插到 shebang 之后
#                   ③ .md 用 HTML 注释包裹, 避免版权行变成 H1 标题; 带 frontmatter(首行 ---)的 .md 跳过
#                   ④ 跳过 .gitignore 忽略的内部资产(MEMORY-*.md / docs/内部 / 缓存), 不污染内部笔记与缓存
# 参考: AGENTS#5 git 操作规范 + §13.39 P0 git 污染教训

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${DRY_RUN:=true}"   # 默认 dry-run；真跑用: DRY_RUN=false bash scripts/add-copyright-header.sh
# 设 DRY_RUN=false 即真跑: DRY_RUN=false bash scripts/add-copyright-header.sh

EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  "docs/10-initiatives"
  "docs/09-review"
  ".hermes"
  "raven-mapping"
)
# 脚本自身 / 已有 header 的 demo 文件单独排除
EXCLUDE_FILES=(
  "scripts/add-copyright-header.sh"
  "scripts/demo-tour.sh"
)

# 版权头(纯注释, 不带 shebang); 按文件类型选注释语法：
#   .md            → HTML 注释（frontmatter 文件在 apply_header 跳过）
#   .js/.ts/.cjs/.mjs → // 注释（JS/TS 不支持 # 注释，# 是私有字段语法会 SyntaxError）
#   其余(.py 等)   → # 注释（Python/Shell 用 #）
build_header() {
  local f="$1"
  if [[ "$f" == *.md ]]; then
    cat <<'EOF'
<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

EOF
  elif [[ "$f" == *.js || "$f" == *.ts || "$f" == *.cjs || "$f" == *.mjs ]]; then
    cat <<'EOF'
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

EOF
  else
    cat <<'EOF'
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project.

EOF
  fi
}

# 判断文件是否已有 copyright header (前 8 行匹配)
has_header() {
  head -8 "$1" | grep -q 'Copyright.*xiaoxian'
}

# 真正加头: 保留首行 shebang(若有); 带 frontmatter 的 .md 不碰
apply_header() {
  local f="$1"
  local tmp="$f.tmp"
  # frontmatter 保护: .md 首行是 --- 则跳过(避免破坏 YAML frontmatter)
  if [[ "$f" == *.md ]]; then
    local first_md
    first_md="$(head -1 "$f")"
    if [[ "$first_md" == "---" ]]; then
      echo "  ↷ 跳过 frontmatter .md: $f"
      return 0
    fi
  fi
  local first_line
  first_line="$(head -1 "$f")"
  if [[ "$first_line" == "#!"* ]]; then
    {
      printf '%s\n' "$first_line"
      build_header "$f"
      tail -n +2 "$f"
    } > "$tmp"
  else
    {
      build_header "$f"
      cat "$f"
    } > "$tmp"
  fi
  mv "$tmp" "$f"
}

# 收集候选文件
candidates=()
while IFS= read -r -d '' f; do
  # 跳过 exclude dirs
  skip=false
  for ex in "${EXCLUDE_DIRS[@]}"; do
    [[ "$f" == *"/$ex/"* ]] && skip=true && break
  done
  $skip && continue
  # 跳过 exclude files
  for exf in "${EXCLUDE_FILES[@]}"; do
    [[ "$f" == "./$exf" ]] && skip=true && break
  done
  $skip && continue
  # 跳过已有 header 的
  has_header "$f" && continue
  candidates+=("$f")
done < <(find . \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.ts' -o -name '*.py' -o -name '*.md' \) -type f -print0 2>/dev/null)

# ④ 过滤被 .gitignore 忽略的内部资产（MEMORY-*.md / docs/内部 / .pytest_cache 等）：
#    这些文件在盘上但永不进公开仓，不该被版权头脚本改动，避免污染内部笔记与缓存。
#    用 git check-ignore -z（NUL 分隔、不包裹引号）避免中文路径被加引号后比较失配。
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  filtered=()
  for f in "${candidates[@]}"; do
    # 逐文件用退出码判断：0=被忽略（内部资产，跳过），1=未忽略（保留）。
    # 用 -q 退出码而非解析输出，避开中文路径被 git 加引号导致的比较失配。
    if git check-ignore -q -- "$f" 2>/dev/null; then
      : # 被 .gitignore 忽略的内部资产，不改动
    else
      filtered+=("$f")
    fi
  done
  candidates=("${filtered[@]}")
fi

total=${#candidates[@]}
echo "=== Copyright Header Dry-Run (DRY_RUN=$DRY_RUN) ==="
echo "候选文件数: $total"

if $DRY_RUN; then
  echo "DRY-RUN 模式: 只列出文件, 不修改"
  echo "--- 全部候选 ---"
  printf '%s\n' "${candidates[@]}"
  echo ""
  echo "执行真正修改请设 DRY_RUN=false 并跑:"
  echo "  DRY_RUN=false bash scripts/add-copyright-header.sh"
else
  echo "RUN 模式: 开始加头..."
  added=0
  for f in "${candidates[@]}"; do
    apply_header "$f"
    added=$((added + 1))
  done
  echo "完成: $added 个文件已加头"
  echo ""
  echo "下一步(必须显式 git add --):"
  echo "  git status --short | head -30"
  echo "  git add -- <explicit-files>   # 不要 git add -A"
  echo "  git commit -m 'chore(license): 批量加版权头 (\$added 文件)'"
fi
