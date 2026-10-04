#!/usr/bin/env bash
# push-gate-check.sh — 内部资产 push 闸门（2026-09-28 维护者拍板升级）
#
# 原理：.gitignore 的「内部资产：永不提交」段是唯一的 single source of truth。
# 本脚本把该段每条 gitignore 模式转成正则，校验目标 commit 的 git tree 中
# 不存在任何匹配文件。命中即 exit 1。
#
# 用法：
#   bash scripts/push-gate-check.sh [commit]   # 校验某个 commit（默认 HEAD）
#   bash scripts/push-gate-check.sh --install  # 安装 .git/hooks/pre-push 拦截
#
# 为什么需要 CI：.gitignore 挡不住 `git add -f`、手工 `git add`、
# 或 .gitignore 段新增后忘了 untrack 的存量文件。闸门段与 CI 同源，
# 改 .gitignore 段 = 自动改闸门。

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MARKER='# ===== 内部资产：永不提交'
SECTION=".gitignore"

usage() { echo "usage: $0 [commit] | --install"; exit 2; }

if [ "${1:-}" = "--install" ]; then
  HOOK=".git/hooks/pre-push"
  cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# pre-push hook: 拦截即将推送的每个 commit 的 tree
local=$(git rev-parse --abbrev-ref HEAD)
zero=0000000000000000000000000000000000000000
fail=0
while read -r _localref localsha _remoteref remotesha; do
  if [ "$localsha" = "$zero" ]; then continue; fi   # tag deletion 等
  echo "[push-gate] checking $localsha ($(git log -1 --format=%s "$localsha" 2>/dev/null | head -c 40))"
  bash scripts/push-gate-check.sh "$localsha" || fail=1
done
if [ "$fail" -eq 1 ]; then
  echo ""
  echo "[push-gate] 命中内部资产，push 被拦截。"
  echo "[push-gate] 处理: git rm --cached <file> && git commit，或确认该文件应公开。"
  exit 1
fi
echo "[push-gate] all clear"
EOF
  chmod +x "$HOOK"
  echo "installed .git/hooks/pre-push"
  exit 0
fi

COMMIT="${1:-HEAD}"
[ -z "$1" ] && COMMIT=HEAD

python3 - "$COMMIT" "$SECTION" "$MARKER" <<'PY'
import re, subprocess, sys
commit, ig_path, marker = sys.argv[1], sys.argv[2], sys.argv[3]

text = open(ig_path, encoding="utf-8").read()
if marker not in text:
    print(f"push-gate: .gitignore 缺少标记段 {marker!r}，闸门失效，FAIL")
    sys.exit(1)

section = text.split(marker, 1)[1]
pats = []
for line in section.splitlines():
    s = line.strip()
    if not s or s.startswith("#"):
        continue
    pats.append(s)
if not pats:
    print("push-gate: 标记段内无规则，FAIL")
    sys.exit(1)

def gitpat_to_re(p):
    # gitignore 无 / 前缀 = 任意层级；本仓规则都以具体路径/固定名开头，按仓库根匹配即可
    # 处理: 尾部 / = 目录；* = 通配
    if p.endswith("/"):
        p = p[:-1]
        return "^" + re.escape(p).replace(r"\*", ".*") + r"(?:/.*)?$"
    r = re.escape(p).replace(r"\*", ".*")
    return "^" + r + "$"

rxs = [(p, re.compile(gitpat_to_re(p))) for p in pats]

# -c core.quotePath=false：默认会把中文名输出成 "17-\345\274\200..."（行首是双引号），
# 导致所有行首锚定规则（^17- / ^MEMORY\.md$ 等）对中文名全部失效、闸门静默放行。
tree = subprocess.run(["git", "-c", "core.quotePath=false", "ls-tree", "-r", commit, "--name-only"],
                      capture_output=True, text=True, check=True).stdout.splitlines()

hits = []
for line in tree:
    for p, rx in rxs:
        if rx.match(line):
            hits.append((line, p))
            break

if hits:
    print(f"push-gate: 命中 {len(hits)} 个内部文件（规则 {len(pats)} 条 / tree {len(tree)} 文件）:")
    for line, p in hits[:30]:
        print(f"  {line}   ← {p}")
    if len(hits) > 30:
        print(f"  ... +{len(hits)-30} more")
    sys.exit(1)

print(f"push-gate: OK ({commit[:7] if len(commit)>7 else commit}, tree {len(tree)} files, rules {len(pats)})")
PY
