#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project.

"""
dep-audit.py — 依赖供应链审计棘轮闸（ratchet gate）。

背景（2026-10-23，LiteLLM 投毒事件复盘）：
  那条攻击链是「工程师 GitHub CLI OAuth token 被偷 → 3 个工程师账号 →
  改 release pipeline → 从李鬼仓库 Berri-AI/litellm（多一个连字符）构建 →
  PyPI 上的 litellm 1.107.0 内置 16 模块窃密器（专偷 Claude Code /
  Cursor / Copilot / Gemini CLI / Codex 的凭据文件与 .env）」。
  恶意轮子只存活 1 小时 44 分钟，任何在那期间 unpinned 拉包的构建都会中。
  本仓库当时只有功能门禁，没有任何依赖审计步骤 —— 对「CI 里 unpinned
  拉包」这一环零可见。这个脚本补那一环。

为什么不按 total 设清零闸（量出来的，不是猜的）：
  2026-10-23 实测，全量（含 devDependencies）：
    codex-proxy            38 条（6 moderate / 31 high /  1 critical）
    cursor-proxy           41 条（6 moderate / 33 high /  2 critical）
    multi-proxy-manager    45 条（11 moderate / 33 high / 1 critical）
  九成在 jest / babel / @electron/get 的 dev 树上，不进产物。按 total 设闸
  等于第一天就全红，红到没人看，等于没有闸。

所以按「生产依赖的 critical+high」设棘轮。同一天 --omit=dev 之后实测：
    codex-proxy            1 critical          （proxy-addr，express 4.22.2 传递）
    cursor-proxy           1 critical + 2 high （proxy-addr / compression / undici）
    multi-proxy-manager    1 critical + 2 high （proxy-addr / axios / follow-redirects）
  基线就是这三个数：高于基线 exit 1，等于基线不拦。

棘轮而不是清零，因为存量里真有修不动的：proxy-addr 的 critical 要等
  express 5（4.22.2 已是最新 4.x，而漏洞范围是 1.1.0–2.0.7，2.0.8 才修）。
  清零要等升级排期，不是加个闸门能催出来的。等存量清完，把 BASELINE 里的
  数字改成 0，这个闸就自动变成清零闸 —— 那是一次 reviewed edit。

棘轮的一个已知代价：GitHub Advisory / OSV 库新增公告也会让计数涨过基线。
  那不是当前 PR 的错，但确实是产物里多了一条 high，值得红一次让人来决定
  「修」还是「抬基线」。

审计只读 lockfile，不 npm ci（实测：把 package.json + package-lock.json
  cp 到空目录就能出全量报告），所以这个 job 比 codex/cursor/manager 三个
  job 快一个量级，不需要 npm cache。

用法：
  python3 scripts/dep-audit.py              # 跑全部，超基线 exit 1
  python3 scripts/dep-audit.py --verbose    # 连 moderate/low/info 一起打明细

环境变量：
  PIP_AUDIT_CMD  覆盖 pip-audit 的调用方式。默认依次尝试
                  "<本解释器> -m pip_audit" 和 PATH 上的 "pip-audit"。
                  CI 用 actions/setup-python 的 python，默认值即可；
                  本机没装 pip-audit 时可设成某个 venv 里的解释器，例如
                  PIP_AUDIT_CMD="/tmp/paudit/bin/python -m pip_audit"。
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 生产依赖 critical+high 基线。2026-10-23 清理后实测 npm audit --omit=dev 三项全 0，
# 故收为 0 成为清零闸：任何新增的生产依赖 critical/high 都会让门禁变红。
# 改这里的数字 = 抬基线或收闸，是一次 reviewed edit；请在注释里记下日期和原因。
NPM_BASELINE = {
    "codex-proxy": 0,
    "cursor-proxy": 0,
    "multi-proxy-manager": 0,
}

# hermes-proxy 的 pip 侧基线。审计对象已改为 requirements.lock（全依赖锁定，
# 2026-10-23 由 requirements.txt 经 uv pip compile 生成；flask→3.1.3、requests→2.33.0、
# pyyaml 6.0.1 及全部传递依赖钉死）。清理后按 (包, 公告) 去重实测 0 条，收为 0 清零闸。
PIP_BASELINE = 0
PIP_TARGET = "hermes-proxy/requirements.lock"

RETRIES = 2          # npm audit / pip-audit 各重试几次（registry 偶发不可达）
RETRY_SLEEP = 3      # 秒
CMD_TIMEOUT = 300    # 秒；pip-audit 要建临时 venv 并解析依赖，比 npm audit 慢


def _run(cmd: list[str], cwd: Path | None = None, timeout: int = CMD_TIMEOUT):
    return subprocess.run(
        cmd, cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, timeout=timeout,
    )


def _retry(what: str, fn):
    """fn() 返回已解析的 JSON；失败重试 RETRIES 次后抛 RuntimeError。"""
    last = ""
    for attempt in range(1, RETRIES + 1):
        try:
            return fn()
        except RuntimeError as exc:
            last = str(exc)
            if attempt < RETRIES:
                print(f"  ! {what} 第 {attempt} 次失败，{RETRY_SLEEP}s 后重试")
                time.sleep(RETRY_SLEEP)
    raise RuntimeError(f"{what} 连续 {RETRIES} 次失败：{last[:1500]}")


def npm_audit(project: str) -> dict:
    """跑 npm audit --omit=dev 并返回 JSON。

    有漏洞时 npm audit 自己 exit 1，那是正常结果不是错误；拿不到 JSON 才叫失败。
    """

    def _once() -> dict:
        proc = _run(["npm", "audit", "--omit=dev", "--json"], cwd=REPO_ROOT / project)
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(
                f"stdout 不是 JSON（exit {proc.returncode}）\n"
                f"stdout: {(proc.stdout or '')[:600]}\nstderr: {(proc.stderr or '')[:600]}"
            )

    return _retry(f"{project} npm audit", _once)


def summarize_npm(data: dict) -> tuple[dict, list[tuple[str, str, str, str]]]:
    """返回 (各级计数, [(severity, 包名, 版本范围, 标题), ...])，只收 high/critical。"""
    meta = data.get("metadata", {}).get("vulnerabilities", {})
    counts = {k: int(meta.get(k, 0) or 0) for k in
              ("info", "low", "moderate", "high", "critical", "total")}
    findings = []
    for name, info in sorted(data.get("vulnerabilities", {}).items()):
        sev = info.get("severity", "?")
        if sev not in ("high", "critical"):
            continue
        titles = [v.get("title", "") for v in info.get("via", []) if isinstance(v, dict)]
        findings.append((sev, name, info.get("range", "?"), titles[0] if titles else "（经依赖链传入）"))
    return counts, findings


def _pip_audit_cmd() -> list[str]:
    override = os.environ.get("PIP_AUDIT_CMD")
    if override:
        return shlex.split(override)
    if _run([sys.executable, "-c", "import pip_audit"], timeout=60).returncode == 0:
        return [sys.executable, "-m", "pip_audit"]
    exe = shutil.which("pip-audit")
    if exe:
        return [exe]
    raise RuntimeError("找不到 pip-audit：先 pip install pip-audit，或用 PIP_AUDIT_CMD 指定")


def pip_findings(req_rel: str) -> list[tuple[str, str, str, str]]:
    """跑 pip-audit 并返回 [(包名, 版本, 公告 id, 修复版本), ...]，按 (包, id) 去重。"""
    cmd = _pip_audit_cmd()

    def _once() -> dict:
        proc = _run(cmd + ["-r", req_rel, "--format", "json"], cwd=REPO_ROOT)
        # 有漏洞时 pip-audit exit 1，正常；拿不到 JSON 才叫失败
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(
                f"stdout 不是 JSON（exit {proc.returncode}）\n"
                f"stdout: {(proc.stdout or '')[:600]}\nstderr: {(proc.stderr or '')[:600]}"
            )

    data = _retry(f"{req_rel} pip-audit", _once)
    out, seen = [], set()
    for dep in data.get("dependencies", []):
        name, version = dep.get("name", "?"), dep.get("version", "?")
        for vuln in dep.get("vulns", []):
            vid = vuln.get("id", "?")
            if (name, vid) in seen:
                continue
            seen.add((name, vid))
            fix = ", ".join(vuln.get("fix_versions") or []) or "-"
            out.append((name, version, vid, fix))
    return sorted(out)


def main() -> int:
    verbose = "--verbose" in sys.argv[1:]
    print("=" * 72)
    print("依赖供应链审计 — 生产依赖 critical+high 棘轮闸（基线 2026-10-23 实测）")
    print("=" * 72)

    failures: list[str] = []

    print("\n[npm] 只审计生产依赖（--omit=dev；dev 树存量另见脚本头注释）")
    for project in NPM_BASELINE:
        lock = REPO_ROOT / project / "package-lock.json"
        if not lock.is_file():
            # 缺 lockfile 本身就是本次要堵的洞，不是可以跳过的小事
            print(f"🔴 {project}: 缺 package-lock.json —— unpinned 拉包，审计无从谈起")
            failures.append(f"{project}: 缺 package-lock.json")
            continue
        try:
            data = npm_audit(project)
        except RuntimeError as exc:
            print(f"🔴 {project}: 审计工具失败 — {exc}")
            failures.append(f"{project}: 审计工具失败")
            continue

        counts, findings = summarize_npm(data)
        gate = counts["high"] + counts["critical"]
        base = NPM_BASELINE[project]
        breakdown = (f"critical={counts['critical']} high={counts['high']} "
                     f"moderate={counts['moderate']} low={counts['low']} info={counts['info']} "
                     f"total={counts['total']}")
        if gate > base:
            print(f"🔴 {project}: 生产依赖 high+critical = {gate} > 基线 {base} → 新增供应链债务")
            failures.append(f"{project}: high+critical {gate} > 基线 {base}")
        else:
            print(f"✅ {project}: 生产依赖 high+critical = {gate}（基线 {base}）")
        print(f"     {breakdown}")
        for sev, name, rng, title in findings:
            mark = "🔴" if sev == "critical" else "🟠"
            print(f"     {mark} [{sev}] {name}@{rng} — {title}")
        if verbose:
            for name, info in sorted(data.get("vulnerabilities", {}).items()):
                if info.get("severity") in ("high", "critical"):
                    continue
                print(f"     · [{info.get('severity')}] {name}@{info.get('range', '?')}")

    print(f"\n[pip] 审计 {PIP_TARGET}")
    if not (REPO_ROOT / PIP_TARGET).is_file():
        print(f"🔴 {PIP_TARGET} 不存在")
        failures.append(f"{PIP_TARGET} 不存在")
    else:
        try:
            findings = pip_findings(PIP_TARGET)
        except RuntimeError as exc:
            print(f"🔴 pip-audit 失败 — {exc}")
            failures.append("pip-audit 工具失败")
        else:
            if len(findings) > PIP_BASELINE:
                print(f"🔴 pip 侧公告 {len(findings)} 条 > 基线 {PIP_BASELINE} → 新增供应链债务")
                failures.append(f"pip 公告 {len(findings)} > 基线 {PIP_BASELINE}")
            else:
                print(f"✅ pip 侧公告 {len(findings)} 条（基线 {PIP_BASELINE}）")
            for name, version, vid, fix in findings:
                print(f"     🔴 {name} {version} — {vid}（修复 {fix}）")

    print("\n" + "=" * 72)
    if failures:
        print(f"结论：不过。{len(failures)} 项超基线/失败：")
        for f in failures:
            print(f"  - {f}")
        print("处理方式：修掉它，或改脚本顶部的基线数字（= 一次 reviewed edit，注明日期和原因）。")
        return 1
    print("结论：过。全部子项目生产依赖 critical+high 未超基线。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
