#!/usr/bin/env bash
# add-copyright-header.sh — DRY-RUN (默认关, 不执行)
# 用途: 批量给 multi-proxy 仓内 .js/.ts/.py/.md 加版权头
# 铁律: 默认只做 dry-run, 维护者说一句 "run" 才真改; git add -- 显式列文件
# 参考: AGENTS#5 git 操作规范 + §13.39 P0 git 污染教训

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=true  # 默认干跑, 改 false 才真执行
TARGET_GLOBS=(
  "*.js"
  "*.ts"
  "*.py"
  "*.md"
)
EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  "docs/10-initiatives"
  "docs/09-review"
  ".hermes"
  "raven-mapping"
  "scripts/demo-tour.sh"  # 已有自己 header
)

COPYRIGHT_HEADER="#!/usr/bin/env bash
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project."

# 辅助: 判断文件是否已有 copyright header (前 5 行匹配)
has_header() {
  head -5 "$1" | grep -q 'Copyright.*xiaoxian'
}

# 收集候选文件
candidates=()
for glob in "${TARGET_GLOBS[@]}"; do
  while IFS= read -r -d '' f; do
    # 跳过 exclude dirs
    skip=false
    for ex in "${EXCLUDE_DIRS[@]}"; do
      [[ "$f" == *"/$ex/"* ]] && skip=true && break
    done
    $skip && continue
    # 跳过已有 header 的
    has_header "$f" && continue
    candidates+=("$f")
  done < <(find . -name "$glob" -type f -print0 2>/dev/null)
done

total=${#candidates[@]}
echo "=== Copyright Header Dry-Run (DRY_RUN=$DRY_RUN) ==="
echo "候选文件数: $total"

if $DRY_RUN; then
  echo "DRY-RUN 模式: 只列出文件, 不修改"
  echo "--- 前 20 个候选 ---"
  printf '%s\n' "${candidates[@]:0:20}"
  [ $total -gt 20 ] && echo "... 还有 $((total - 20)) 个文件未显示"
  echo ""
  echo "执行真正修改请设 DRY_RUN=false 并跑:"
  echo "  DRY_RUN=false bash $0"
else
  echo "RUN 模式: 开始加头..."
  added=0
  for f in "${candidates[@]}"; do
    {
      echo "$COPYRIGHT_HEADER"
      cat "$f"
    } > "$f.tmp" && mv "$f.tmp" "$f"
    added=$((added + 1))
  done
  echo "完成: $added 个文件已加头"
  echo ""
  echo "下一步(必须显式 git add --):"
  echo "  git status --short | head -30"
  echo "  git add -- <explicit-files>   # 不要 git add -A"
  echo "  git commit -m 'chore(license): 批量加版权头 ($added 文件)'"
fi
