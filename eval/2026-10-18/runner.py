#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
"""
runner.py — 按 docs/EVAL-成本验收协议-2026-10-18.md 跑一轮评测。

设计要点：
  - 串行执行，一次一个请求，避免并发把延迟量污染。
  - 每次调用在 system 里塞一个随机 nonce，强制不吃上一轮的前缀缓存
    （协议第三节：两次之间清空上下文，别让缓存把第二次变简单）。
  - duration_s 含重试与工具执行，从发请求开始算到判定结束。
  - 结果即时追加进 JSONL，中途挂了不丢已跑的部分。
  - cost_cny 由 pricing.py 从 usage 折算（网关 sidecar 不回传金额给调用方，只能自己折）。
    ⚠️ 折算结果必须连 cost_basis 一起看：unbillable/unknown 模型的 cost 是 0，
    但那是「不知道」，不是「免费」，拿它当分母就会算出省了 100%。

用法：
  python3 runner.py --tasks tasks.json --out runs.jsonl \
      --endpoint http://127.0.0.1:18797 \
      --group strong=deepseek-v4-pro --group cheap=deepseek-v4-flash
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from pricing import cost_from_usage  # noqa: E402
MAX_TOK = {"coding": 8000, "rewrite": 4000, "table": 4000}


def call(endpoint, model, messages, max_tokens, timeout=300):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        # 不传 temperature：kimi 上游对 temperature=0 直接回 400（2026-10-18 实测）。
        # 代价是同一题两次的解可能有随机性，这个随机性已经被「每题跑两次」的重复设计吃掉了。
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "ignore"))
    return data, time.monotonic() - t0


def extract_fence(text, langs):
    """取最后一个指定语言的代码块；没有语言标记就取任意最后一个块。"""
    pat = re.compile(r"```(?:%s)?\s*\n(.*?)```" % "|".join(langs), re.S)
    blocks = pat.findall(text)
    if blocks:
        return blocks[-1].strip()
    pat_any = re.compile(r"```[a-zA-Z]*\s*\n(.*?)```", re.S)
    blocks = pat_any.findall(text)
    if blocks:
        return blocks[-1].strip()
    return text.strip()


def judge_table(answer, gt):
    """差异集合严格相等：多报少报都算失败。"""
    raw = extract_fence(answer, ["json"])
    try:
        items = json.loads(raw)
    except Exception:
        m = re.search(r"\[.*\]", answer, re.S)
        if not m:
            return False, "答复里没有 JSON 数组"
        try:
            items = json.loads(m.group(0))
        except Exception:
            return False, "JSON 解析失败"
    if not isinstance(items, list):
        return False, "不是数组"
    got = set()
    for it in items:
        if not isinstance(it, dict):
            return False, "数组元素不是对象"
        row = str(it.get("row", "")).strip().lower()
        fld = str(it.get("field", "")).strip().lower()
        got.add((row, fld))
    want = {(g["row"].strip().lower(), g["field"].strip().lower()) for g in gt}
    if got == want:
        return True, f"命中 {len(want)}/{len(want)}"
    extra = got - want
    miss = want - got
    return False, f"多报 {sorted(extra)} 少报 {sorted(miss)}"


def judge_coding(task, answer, rundir):
    target = os.path.join(rundir, task["target_file"])
    code = extract_fence(answer, ["js", "javascript", "python", "py"])
    if not code:
        return False, "没有取到代码块"
    with open(target, "w", encoding="utf-8") as f:
        f.write(code if code.endswith("\n") else code + "\n")
    try:
        p = subprocess.run(task["accept"], shell=True, cwd=rundir,
                           capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return False, "验收命令超时"
    if p.returncode == 0:
        return True, "accept 退出码 0"
    tail = (p.stderr or p.stdout or "").strip().splitlines()
    return False, f"accept 退出码 {p.returncode}: {tail[-1] if tail else '无输出'}"


def judge_rewrite(task, answer):
    tmp_out = os.path.join(HERE, ".tmp_answer.txt")
    tmp_src = os.path.join(HERE, ".tmp_source.txt")
    with open(tmp_out, "w", encoding="utf-8") as f:
        f.write(answer)
    with open(tmp_src, "w", encoding="utf-8") as f:
        f.write(task["source"])
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "check_rewrite.py"),
         "--source", tmp_src, "--output", tmp_out,
         "--keep", ",".join(task["must_keep"]), "--json"],
        capture_output=True, text=True, timeout=60,
    )
    # --json 拿到结构化的失败项：光看退出码看不出「卡在哪一格」，
    # 而首轮最值钱的发现就是 agnes 八次全败里六次只栽在字数上。
    fails = []
    try:
        res = json.loads(p.stdout.strip().splitlines()[-1])
        ok = bool(res["ok"])
        fails = list(res.get("fails") or [])
    except Exception:
        ok = p.returncode == 0
    detail = "五项全过" if ok else " | ".join(fails)
    return ok, detail, fails


def run_one(task, model, endpoint, group, rep, run_root, tasks_dir=None):
    # prompt_file 相对任务集文件所在目录解析（真稿集在 real/ 下，不在本目录）。
    base = tasks_dir or HERE
    prompt = open(os.path.join(base, task["prompt_file"]), encoding="utf-8").read()
    nonce = uuid.uuid4().hex[:12]
    messages = [
        {"role": "system", "content": f"评测会话 {nonce}。严格按用户要求的输出格式作答，不要额外解释。"},
        {"role": "user", "content": prompt},
    ]

    t0 = time.monotonic()
    err = ""
    fatal = False
    data = None
    budget = MAX_TOK[task["class"]]
    for attempt in range(3):
        try:
            data, _ = call(endpoint, model, messages, budget)
            # 这两个模型是推理模型，思考会吃掉 completion 预算；被截断导致正文为空时放大预算重试，
            # 这是跑测脚本的健壮性，不算模型失败，否则等于自己造失败。
            content = ((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()
            finish = (data.get("choices") or [{}])[0].get("finish_reason")
            if not content and finish == "length" and attempt < 2:
                budget *= 2
                continue
            break
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code}"
            # 401/402/403 是账号或额度问题，不是模型能力问题。继续跑只会把后面所有格子
            # 都写成"失败"，把一次欠费记成一次能力评测。必须立刻停，并把这几行标成 invalid。
            if e.code in (401, 402, 403):
                fatal = True
                break
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(3 * (attempt + 1))
                continue
            break
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            time.sleep(2)

    if data is None:
        return {"passed": False, "duration_s": round(time.monotonic() - t0, 1),
                "in_tok": 0, "out_tok": 0, "cache_tok": 0,
                "cost_cny": 0.0, "cost_basis": "unknown-model",
                "fails": [], "fatal": fatal,
                "note": f"调用失败 {err}"}

    usage = data.get("usage") or {}
    answer = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""

    if task["class"] == "coding":
        rundir = os.path.join(run_root, f"{task['id']}-{group}-{rep}")
        if os.path.isdir(rundir):
            shutil.rmtree(rundir)
        shutil.copytree(os.path.join(HERE, task["workdir"]), rundir)
        ok, note = judge_coding(task, answer, rundir)
        fails = []
    elif task["class"] == "rewrite":
        ok, note, fails = judge_rewrite(task, answer)
    else:
        ok, note = judge_table(answer, task["ground_truth"])
        fails = []

    in_tok = usage.get("prompt_tokens", 0) or 0
    out_tok = usage.get("completion_tokens", 0) or 0
    # 各家 provider 的 cache 字段口径不一，两种都试；没有就当 0（不猜）。
    cache_tok = ((usage.get("prompt_tokens_details") or {}).get("cached_tokens")
                 or usage.get("cache_read_input_tokens") or 0)
    cost, basis = cost_from_usage(model, in_tok, out_tok, cache_tok)

    return {
        "passed": ok,
        "duration_s": round(time.monotonic() - t0, 1),
        "in_tok": in_tok,
        "out_tok": out_tok,
        "cache_tok": cache_tok,
        "cost_cny": cost,
        "cost_basis": basis,
        "fails": fails,
        "fatal": False,
        "note": note,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=os.path.join(HERE, "tasks.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "runs.jsonl"))
    ap.add_argument("--endpoint", default="http://127.0.0.1:18797")
    ap.add_argument("--group", action="append", required=True, help="name=model")
    ap.add_argument("--only", default="", help="逗号分隔的题目 ID，只跑这些")
    ap.add_argument("--repeat", type=int, default=0, help="覆盖每题重复次数")
    ap.add_argument("--run-root", default="/tmp/mp-eval")
    a = ap.parse_args()

    groups = [g.split("=", 1) for g in a.group]
    tasks_dir = os.path.dirname(os.path.abspath(a.tasks))
    tasks = json.load(open(a.tasks, encoding="utf-8"))["tasks"]
    if a.only:
        keep = {x.strip() for x in a.only.split(",")}
        tasks = [t for t in tasks if t["id"] in keep]

    os.makedirs(a.run_root, exist_ok=True)

    # 预检：先各打一枪，账号/额度不通就别开始，否则会把 48 个格子写成"失败"。
    for gname, gmodel in groups:
        try:
            call(a.endpoint, gmodel, [{"role": "user", "content": "ok"}], 8, timeout=60)
            print(f"预检 {gname}={gmodel} OK", flush=True)
        except urllib.error.HTTPError as e:
            print(f"预检 {gname}={gmodel} 失败 HTTP {e.code}，中止。"
                  f"（402=额度耗尽 / 401=鉴权失败，均不是模型能力问题）", flush=True)
            sys.exit(2)
        except Exception as e:
            print(f"预检 {gname}={gmodel} 失败 {type(e).__name__}: {e}，中止。", flush=True)
            sys.exit(2)

    total = len(tasks) * len(groups) * (a.repeat or tasks[0]["repeat"])
    done = 0

    with open(a.out, "a", encoding="utf-8") as out:
        aborted = False
        for gname, gmodel in groups:
            if aborted:
                break
            for t in tasks:
                if aborted:
                    break
                reps = a.repeat or t.get("repeat", 2)
                for rep in range(1, reps + 1):
                    r = run_one(t, gmodel, a.endpoint, gname, rep, a.run_root, tasks_dir)
                    row = {
                        "task_id": t["id"], "group": gname, "passed": r["passed"],
                        "duration_s": r["duration_s"], "cost_cny": r["cost_cny"],
                        "judge_cost_cny": 0.0, "steps": 1,
                        "in_tok": r["in_tok"], "out_tok": r["out_tok"],
                        "cache_tok": r["cache_tok"],
                        "model": gmodel, "cost_basis": r["cost_basis"],
                        "fails": r["fails"],
                        "invalid": r["fatal"],
                        "note": r["note"],
                    }
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out.flush()
                    done += 1
                    mark = "PASS" if r["passed"] else ("VOID" if r["fatal"] else "FAIL")
                    print(f"[{done}/{total}] {gname:8s} {t['id']} r{rep} "
                          f"{mark:4s} {r['duration_s']:6.1f}s "
                          f"tok {r['in_tok']}/{r['out_tok']} "
                          f"¥{r['cost_cny']:.4f}[{r['cost_basis'][:14]}]  {r['note'][:50]}",
                          flush=True)
                    if r["fatal"]:
                        print("\n⛔ 账号或额度问题（非模型能力），已中止。"
                              "这几行 invalid=true，不得计入完成率；"
                              "补齐额度后用同一命令续跑同一个 --out 文件即可。", flush=True)
                        aborted = True
                        break
                    time.sleep(1)

    if aborted:
        sys.exit(2)


if __name__ == "__main__":
    main()
