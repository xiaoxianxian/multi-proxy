#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
"""
analyze.py — 把 runs.jsonl 拆成三张表：
  1. 逐题矩阵（哪一组过、哪一组不过，以及两次分别什么结果）
  2. 分类汇总（编码/改写/表格三类的完成率与每成功任务 token）
  3. 路由决策表（按题看弱模型够不够用，这是 capability-profile 的数据来源）

只读 JSONL，不联网。用法：python3 analyze.py runs.jsonl
"""

import collections
import json
import os
import sys


def load(path):
    rows = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#"):
            rows.append(json.loads(line))
    return rows


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "runs-2026-10-18.jsonl"
    rows = load(path)
    voided = [r for r in rows if r.get("invalid")]
    rows = [r for r in rows if not r.get("invalid")]
    if voided:
        print(f"⚠️ 跳过 {len(voided)} 条作废记录（invalid=true，账号/额度问题，非模型能力）\n")
    groups = list(dict.fromkeys(r["group"] for r in rows))
    tasks = list(dict.fromkeys(r["task_id"] for r in rows))
    # 题目 ID → 类别，从 tasks.json 取，不从 ID 前缀猜
    tpath = os.path.join(os.path.dirname(os.path.abspath(path)), "tasks.json")
    if not os.path.exists(tpath):
        tpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")
    cls = {t["id"]: t["class"] for t in json.load(open(tpath, encoding="utf-8"))["tasks"]}

    # 1. 逐题矩阵
    print("## 逐题矩阵（✓=通过 ✗=失败，两格是两次重复）\n")
    head = "题目   " + "".join(f"{g:>14s}" for g in groups)
    print(head)
    print("-" * len(head))
    per_task = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        per_task[r["task_id"]][r["group"]].append(r)
    for t in tasks:
        cells = []
        for g in groups:
            rs = sorted(per_task[t][g], key=lambda x: x["duration_s"])
            marks = "".join("✓" if x["passed"] else "✗" for x in rs)
            cells.append(f"{marks:>14s}")
        print(f"{t:6s}" + "".join(cells))

    # 2. 分类汇总
    print("\n## 分类汇总\n")
    print(f"{'类':10s}{'组':8s}{'运行':>5s}{'通过':>5s}{'完成率':>8s}"
          f"{'平均等待s':>10s}{'每成功任务token':>16s}")
    agg = collections.defaultdict(lambda: {"runs": 0, "pass": 0, "dur": 0.0, "tok": 0})
    for r in rows:
        # 题目不在当前 tasks.json 里（比如拿真稿集跑的 runs 用首轮脚本分析）→ 显式标 unknown，
        # 绝不猜类别：猜成 coding 会让改写题混进编码统计，分两类汇总就全错了。
        k = (cls.get(r["task_id"], "unknown"), r["group"])
        a = agg[k]
        a["runs"] += 1
        a["pass"] += 1 if r["passed"] else 0
        a["dur"] += r["duration_s"]
        a["tok"] += (r.get("in_tok") or 0) + (r.get("out_tok") or 0)
    cats = [c for c in ["coding", "rewrite", "table"] if c in agg]
    cats += sorted({k[0] for k in agg} - set(cats))
    for c in cats:
        for g in groups:
            a = agg.get((c, g))
            if not a:
                continue
            rate = f"{a['pass'] / a['runs'] * 100:.0f}%"
            per = f"{a['tok'] / a['pass']:.0f}" if a["pass"] else "—"
            print(f"{c:10s}{g:8s}{a['runs']:>5d}{a['pass']:>5d}{rate:>8s}"
                  f"{a['dur'] / a['runs']:>10.1f}{per:>16s}")

    # 3. 路由决策表
    if len(groups) >= 2:
        strong, cheap = groups[0], groups[1]
        print(f"\n## 路由决策表（{cheap} 在哪些题上够用）\n")
        print(f"{'题目':6s}{'强模型':>8s}{'弱模型':>8s}{'判定':>10s}{'token 省':>10s}")
        for t in tasks:
            s_rs = per_task[t][strong]
            c_rs = per_task[t][cheap]
            sp = sum(1 for x in s_rs if x["passed"]) / len(s_rs)
            cp = sum(1 for x in c_rs if x["passed"]) / len(c_rs)
            verdict = "可降档" if cp == 1 else ("部分" if cp > 0 else "不可降档")
            s_tok = sum((x.get("in_tok") or 0) + (x.get("out_tok") or 0) for x in s_rs) / len(s_rs)
            c_tok = sum((x.get("in_tok") or 0) + (x.get("out_tok") or 0) for x in c_rs) / len(c_rs)
            save = f"{(1 - c_tok / s_tok) * 100:.0f}%" if s_tok else "—"
            print(f"{t:6s}{sp * 100:>7.0f}%{cp * 100:>7.0f}%{verdict:>10s}{save:>10s}")


if __name__ == "__main__":
    main()
