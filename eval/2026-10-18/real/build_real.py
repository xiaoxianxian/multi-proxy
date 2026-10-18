#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
"""
build_real.py — 生成「真稿改写」任务集。

为什么要有这一份：
  首轮（tasks.json 的 t05-t08）原文只有 143-158 字，且是**刻意写坏的 AI 腔样本**
  （满篇「值得注意的是 / 综上所述 / 亟需」）。用它得出「改写类不可降档」有两个毛病：
    1. 样本太短，模型稍微概括一点就掉出 ±15% 字数带；
    2. 原文是"待修稿"，改它更像"改病句"，不像真实的改写活。
  所以要拿**老板自己已终审的真稿**再验一遍：长度上 1.5 倍、语言上已经是改好的。

  真稿改写是另一道题：换一种说法，信息量不变。字数 ±15% 在这里不是形式主义——
  写掉 40% 那是概括，不是改写。这条约束保留，但脚本会把"只栽在字数上"的次数单独统计出来，
  因为首轮最值钱的发现就是：**卡在哪一格，比通过率这个数本身重要。**

用法：
  python3 real/build_real.py
  python3 real/runner.py --tasks real/tasks-real.json ...
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# 真稿路径**不写死**：仓库是 public 的，家目录绝对路径会带出用户名，而源稿又是未发布文章，
# 路径本身就是一条不该泄露的信息。用环境变量或命令行给：
#   EVAL_REAL_ARTICLE=/path/to/03-成稿.md python3 real/build_real.py
#   python3 real/build_real.py /path/to/03-成稿.md
DEFAULT_ARTICLE = os.environ.get("EVAL_REAL_ARTICLE", "").strip()

# 每段必须保留的关键词/数字。挑的标准：改写成另一种说法时**最容易丢**的那几个
# （专名、四家联合、硬数字）。太常见的词（比如「路由」）不挑，它丢不了，挑了等于放水。
KEEP = [
    ["PilotDeck", "OpenBMB", "七成"],
    ["三笔账", "日志", "源码"],
    ["0.001", "2.7%", "5.4%"],
]

PROMPT = """把这段话改写成另一种说法：换一种讲法，信息量一个点都不能少，结论不能变。

要求：
1. 不许用破折号（——）。
2. 不许用"不是…而是"这种对举句式。
3. 不许出现这些词：值得注意的是、总的来说、综上所述、首先、其次、最后、亟需、赋能、抓手、深度融合、全面提升、良莠不齐、坚实基础。
4. 必须保留这些词或数字：{keep}。
5. 字数（不含空白）与原文相差不超过 15%。这条是硬约束，不是排版偏好：写短了就是漏信息，写长了就是注水。
6. 只输出改写后的正文，不要标题、不要解释、不要代码块、不要前后缀说明。

原文：

{source}
"""


def extract_paragraphs(md_path, min_len=180):
    """从成稿 md 抽正文段落：跳过代码块、标题、表格、列表、引用。

    只取连续行拼成的自然段——表格行以 | 开头，列表以 - 开头，都会打断段落，
    所以它们天然不会混进来。
    """
    paras = []
    buf = []
    in_block = False
    for line in open(md_path, encoding="utf-8"):
        s = line.rstrip("\n")
        if s.strip().startswith("```"):
            in_block = not in_block
            if buf:
                paras.append("".join(buf))
                buf = []
            continue
        if in_block:
            continue
        if s.startswith("#") or s.startswith("|") or s.startswith("- ") or s.startswith(">"):
            if buf:
                paras.append("".join(buf))
                buf = []
            continue
        if s.strip():
            buf.append(s.strip())
        else:
            if buf:
                paras.append("".join(buf))
                buf = []
    if buf:
        paras.append("".join(buf))
    # 去掉 md 加粗标记：它是排版符，不是正文内容，留着会污染字数统计
    paras = [re.sub(r"\*\*(.+?)\*\*", r"\1", p) for p in paras]
    return [p for p in paras if len(p) >= min_len]


def main():
    article = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ARTICLE
    if not article:
        sys.exit("没给源稿路径。用环境变量 EVAL_REAL_ARTICLE 或命令行参数传成稿 .md 路径\n"
                 "（路径不写死在仓库里：public 仓 + 家目录 = 泄露用户名，且源稿未发布）")
    if not os.path.exists(article):
        sys.exit(f"找不到成稿：{article}")

    paras = extract_paragraphs(article)
    # 取前中后三段：第 0 段（引入）、第 2 段（立论）、第 4 段（补证）
    picks = [0, 2, 4]
    if len(paras) < max(picks) + 1:
        sys.exit(f"可用长段落只有 {len(paras)} 段，不足 {max(picks) + 1} 段")

    os.makedirs(os.path.join(HERE, "prompts"), exist_ok=True)
    tasks = []
    for i, idx in enumerate(picks, start=1):
        tid = f"r{i:02d}"
        src = paras[idx]
        keep = KEEP[i - 1]
        pf = f"prompts/{tid}.md"
        with open(os.path.join(HERE, pf), "w", encoding="utf-8") as f:
            f.write(PROMPT.format(keep="、".join(keep), source=src))
        missing = [k for k in keep if k not in src]
        if missing:
            sys.exit(f"{tid} 的 must_keep 有词不在原文里：{missing}（等于题出错了）")
        tasks.append({
            "id": tid,
            "class": "rewrite",
            "prompt_file": pf,
            "source": src,
            "must_keep": keep,
            "accept": "check_rewrite.py",
            "accept_note": "无破折号、无 banned 词、保留关键词、字数 ±15%",
            "repeat": 2,
            "src_len": len(re.sub(r"\s+", "", src)),
            "_from": f"{os.path.basename(article)} 第 {idx} 个长段落",
        })

    out = {
        "_说明": [
            "真稿改写任务集：原文取自老板已终审的公众号成稿，不是刻意写坏的样本。",
            "与首轮 t05-t08 的关系：首轮原文 143-158 字且是 AI 腔待修稿；本集 202-266 字且是改好的稿。",
            "两轮对照才能回答「改写类该不该降档」——单看任一轮，结论都可能被样本长度带偏。",
        ],
        "_已知局限": [
            "只有 3 段，统计功效更低（每组 6 次），只能看方向不能下显著结论。",
            "原文是技术评论，不代表所有改写场景（营销文案、公文改写未覆盖）。",
            "must_keep 是人挑的，换一批关键词结果会变。",
        ],
        "tasks": tasks,
    }
    with open(os.path.join(HERE, "tasks-real.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print(f"源稿：{article}")
    print(f"抽出 ≥180 字段落 {len(paras)} 段，取第 {picks} 段：")
    for t in tasks:
        print(f"  {t['id']}  {t['src_len']:4d} 字  保留 {t['must_keep']}  {t['_from']}")
    print("→ real/tasks-real.json")


if __name__ == "__main__":
    main()
