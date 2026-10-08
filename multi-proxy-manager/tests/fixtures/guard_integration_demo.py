#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project.

"""跨语言端到端验证：side-effect-guard HTTP 端点 + Python 客户端。

模拟一个真实业务写操作（往 jsonl 追加判定结果），经 guard 跑两次，验证：
  1. 第一次：3 条全部写入，guard 账本记 3 completed
  2. 第二次（断点续跑）：guard 幂等判定全部 already-completed → 不重复写
  3. 崩溃孤儿（proposed 后未 record）：reconcile 判 manual，绝不自动重试

用法：先起 tests/fixtures/guard-server.js（设 MULTI_PROXY_SIDE_EFFECT_GUARD=1 MULTI_PROXY_ACTION_AUDIT=1），
再 GUARD_URL=http://127.0.0.1:18999/api/guard CLIENT_DIR=<02-工具路径> python3 本文件。
"""
import json
import os
import sys
import tempfile

CLIENT_DIR = os.environ.get("CLIENT_DIR", os.getcwd())
sys.path.insert(0, CLIENT_DIR)
from side_effect_guard_client import SideEffectGuardClient

BASE = os.environ.get("GUARD_URL", "http://127.0.0.1:18999/api/guard")
guard = SideEffectGuardClient(BASE)

tmp = tempfile.mktemp(suffix=".jsonl", prefix="seg-demo-")


def run_once(label):
    skipped = 0
    written = 0
    rows = [{"id": f"r{i}"} for i in range(3)]
    for r in rows:
        key = f"{tmp}:{r['id']}"
        dec = guard.before_action(action="submit_decision", idempotency_key=key, actor="demo", resource=tmp)
        if not dec.get("proceed") and dec.get("reason") == "already-completed":
            skipped += 1
            continue
        written += 1
        with open(tmp, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": r["id"], "status": "ok"}) + "\n")
        guard.record_result(idempotency_key=key, result="completed", action="submit_decision", resource=tmp)
    print(f"{label}: written={written} skipped={skipped}")
    return written, skipped


w1, s1 = run_once("FIRST")
w2, s2 = run_once("SECOND")
lines = len([l for l in open(tmp).read().splitlines() if l.strip()])
pending = guard.reconcile_pending()
print(f"OUTPUT_LINES={lines} PENDING={len(pending)}")

assert w1 == 3 and s1 == 0, f"FIRST 应写 3 条: {w1}/{s1}"
assert w2 == 0 and s2 == 3, f"SECOND 应全 skip: {w2}/{s2}"
assert lines == 3, f"输出应 3 行: {lines}"
assert len(pending) == 0, f"pending 应空: {len(pending)}"

# 崩溃孤儿场景：proposed 后不 record → reconcile 应 manual（绝不自动重试）
orphan_key = f"{tmp}:orphan"
guard.before_action(action="submit_decision", idempotency_key=orphan_key, actor="demo", resource=tmp)
rec = guard.reconcile(orphan_key)
print(f"ORPHAN_RECONCILE={rec['decision']}")
assert rec["decision"] == "manual", f"orphan 应 manual 非 retry: {rec}"

print("ALL_GUARD_INTEGRATION_PASS")
