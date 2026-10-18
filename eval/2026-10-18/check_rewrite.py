#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
"""
check_rewrite.py — 改写类题目的验收脚本（规矩一：验收脚本自己写，不用被测方提供的）。

判定五项，全过才算通过：
  1. 不含破折号（—— 或 —）
  2. 不含「不是…而是」对举句
  3. 不含 banned 词表
  4. 必须保留的关键词/数字全在
  5. 字数（去空白）与原文相差不超过 15%

用法：
  python3 check_rewrite.py --source <原文文件> --output <产出文件> --keep 判定开销,降档,缓存

退出码 0 = 通过；1 = 不通过（逐条打印失败原因）。
"""

import argparse
import json
import re
import sys

BANNED = [
    "值得注意的是", "总的来说", "综上所述", "首先", "其次", "最后",
    "亟需", "赋能", "抓手", "深度融合", "全面提升", "良莠不齐", "坚实基础",
]

DASH = re.compile(r"[—–]{1,2}")
ANTITHESIS = re.compile(r"不是[^。，；\n]{0,20}而是")


def normalize(s):
    return re.sub(r"\s+", "", s)


def check(source, output, keep):
    fails = []
    if DASH.search(output):
        fails.append(f"含破折号：{DASH.findall(output)[:3]}")
    m = ANTITHESIS.search(output)
    if m:
        fails.append(f"含「不是…而是」：{m.group(0)}")
    hit = [w for w in BANNED if w in output]
    if hit:
        fails.append(f"含 banned 词：{hit}")
    missing = [w for w in keep if w not in output]
    if missing:
        fails.append(f"缺关键词：{missing}")

    n_src = len(normalize(source))
    n_out = len(normalize(output))
    if n_src:
        ratio = n_out / n_src
        if not (0.85 <= ratio <= 1.15):
            fails.append(f"字数比 {ratio:.2f}（{n_out}/{n_src}），超出 ±15%")
    else:
        fails.append("原文为空")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--keep", default="")
    # --json：给 runner 用。跑测要统计「卡在哪一格」，光看退出码不够——
    # 首轮最值钱的发现就是 agnes 八次全败里六次只栽在字数上，而这个只有逐条拆开才看得见。
    ap.add_argument("--json", action="store_true", help="输出 JSON {'ok':bool,'fails':[...]}")
    a = ap.parse_args()

    source = open(a.source, encoding="utf-8").read()
    output = open(a.output, encoding="utf-8").read()
    keep = [x.strip() for x in a.keep.split(",") if x.strip()]

    fails = check(source, output, keep)
    if a.json:
        print(json.dumps({"ok": not fails, "fails": fails}, ensure_ascii=False))
        sys.exit(1 if fails else 0)
    if fails:
        print("FAIL")
        for f in fails:
            print(" -", f)
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
