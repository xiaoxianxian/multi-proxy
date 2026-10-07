#!/usr/bin/env python3
"""cjbench 风格幂等接线验证：提交前查证 + 并发 worker + 写入后落账。

直接复刻 cjbench_local_run.py 的接线形态（ThreadPoolExecutor，幂等查证放在提交前），
用 stub work（写 jsonl 模拟模型打分）跑两次，验证：
  1. 第一次：3 条全部提交、写入、guard 记 completed
  2. 第二次（模拟另一个进程、起始 done 快照为空 → 看不到第一次已写的结果）：
     guard 幂等查证全部 already-completed → 提交前跳过，不重复写

用法：先起 tests/fixtures/guard-server.js（MULTI_PROXY_SIDE_EFFECT_GUARD=1 MULTI_PROXY_ACTION_AUDIT=1），
再 GUARD_URL=http://127.0.0.1:18999/api/guard CLIENT_DIR=<02-工具路径> python3 本文件。
"""
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

CLIENT_DIR = os.environ.get("CLIENT_DIR", os.getcwd())
sys.path.insert(0, CLIENT_DIR)
from side_effect_guard_client import SideEffectGuardClient

BASE = os.environ.get("GUARD_URL", "http://127.0.0.1:18999/api/guard")
guard = SideEffectGuardClient(BASE)

OUT = os.environ.get("CJ_DEMO_OUT", tempfile.mktemp(suffix=".jsonl", prefix="cjdemo-"))


def work(rec):
    time.sleep(0.01)
    return {"id": rec["id"], "probabilities": [0.9, 0.1]}


def run_once(label):
    written = 0
    skipped = 0
    todo = [{"id": f"r{i}"} for i in range(3)]
    # 模拟「另起进程、起始 done 快照为空」：不读 OUT，todo 永远 3 条
    fout = open(OUT, "a", encoding="utf-8")
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = {}
        for r in todo:
            if guard.enabled():
                dec = guard.before_action(
                    action="score_row",
                    idempotency_key=f"{OUT}:{r['id']}",
                    actor="cjbench_local_run",
                    resource=OUT,
                )
                if not dec.get("proceed") and dec.get("reason") == "already-completed":
                    skipped += 1
                    continue
            futs[pool.submit(work, r)] = r
        for fut in as_completed(futs):
            rec = futs[fut]
            out = fut.result()
            fout.write(json.dumps(out, ensure_ascii=False) + "\n")
            fout.flush()
            if guard.enabled():
                guard.record_result(
                    idempotency_key=f"{OUT}:{rec['id']}",
                    result="completed",
                    action="score_row",
                    resource=OUT,
                )
            written += 1
    fout.close()
    print(f"{label}: written={written} skipped={skipped}")
    return written, skipped


w1, s1 = run_once("FIRST")
w2, s2 = run_once("SECOND")
lines = len([l for l in open(OUT).read().splitlines() if l.strip()])
print(f"OUTPUT_LINES={lines}")
assert w1 == 3 and s1 == 0, f"FIRST 应写 3: {w1}/{s1}"
assert w2 == 0 and s2 == 3, f"SECOND 应全 skip（并发/跨进程重复）: {w2}/{s2}"
assert lines == 3, f"输出应 3 行: {lines}"
print("ALL_CJBENCH_STYLE_GUARD_PASS")
