#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
"""
build.py — 生成 2026-10-18 这一轮评测的任务集（fixtures + prompts + tasks.json）。

为什么用脚本生成而不是手写文件：
  题目、初始 bug、验收命令三者必须严格对齐；手写容易改了一处忘另一处，
  生成器保证「题目正文里说的验收命令」与「runner 真正执行的命令」是同一个字符串。

三类各 4 题，共 12 题。全部机器可判。见 docs/EVAL-成本验收协议-2026-10-18.md 第三节。
"""

import json
import os
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(BASE, "fixtures")
PROMPT = os.path.join(BASE, "prompts")


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# ---------------------------------------------------------------- 编码类 t01-t04

T01_LIB = """// sumRange(nums, start, end) 应返回 nums[start..end] 的和（含 end）
function sumRange(nums, start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += nums[i];
  }
  return total;
}

module.exports = { sumRange };
"""

T01_TEST = """const assert = require('assert');
const { sumRange } = require('./lib');

assert.strictEqual(sumRange([1, 2, 3, 4], 1, 3), 9, '闭区间求和应为 2+3+4=9');
assert.strictEqual(sumRange([5, 5, 5], 0, 2), 15, '全区间求和');
assert.strictEqual(sumRange([1, 2, 3], 2, 2), 3, '单元素区间');
console.log('t01 OK');
"""

T02_LIB = """// parseLine(line) 按逗号切分一行 CSV，双引号内的逗号不作为分隔符
function parseLine(line) {
  return line.split(',');
}

module.exports = { parseLine };
"""

T02_TEST = """const assert = require('assert');
const { parseLine } = require('./parse');

assert.deepStrictEqual(parseLine('a,"b,c",d'), ['a', 'b,c', 'd'], '引号内逗号不分隔');
assert.deepStrictEqual(parseLine('a,b,c'), ['a', 'b', 'c'], '普通行');
console.log('t02 OK');
"""

T03_LIB = """def median(xs):
    s = sorted(xs)
    return s[len(s) // 2]
"""

T03_TEST = """from stats import median

assert median([1, 2, 3]) == 2, '奇数个取中间'
assert median([1, 2, 3, 4]) == 2.5, '偶数个应取中间两个的平均'
assert median([4, 4, 1, 9]) == 4, '乱序输入'
print('t03 OK')
"""

T04_LIB = """// byGroup(rows) 把 rows 按 group 字段累加 cost，缺 group 的归到 'unknown'
function byGroup(rows) {
  const out = {};
  for (const r of rows) {
    out[r.group] = (out[r.group] || 0) + r.cost;
  }
  return out;
}

module.exports = { byGroup };
"""

T04_TEST = """const assert = require('assert');
const { byGroup } = require('./agg');

const rows = [
  { group: 'a', cost: 2 },
  { group: 'a', cost: 3 },
  { group: 'b', cost: 1 },
  { cost: 4 },
  { group: 'c' },
];
assert.strictEqual(byGroup(rows).a, 5, '同组累加');
assert.strictEqual(byGroup(rows).unknown, 4, '缺 group 归到 unknown');
assert.strictEqual(byGroup(rows).c, 0, '有 group 无 cost 记 0');
assert.strictEqual(byGroup(rows).undefined, undefined, '不得出现 undefined 键');
console.log('t04 OK');
"""

CODING = [
    ("t01", "lib.js", T01_LIB, "test.js", T01_TEST, "node test.js"),
    ("t02", "parse.js", T02_LIB, "test.js", T02_TEST, "node test.js"),
    ("t03", "stats.py", T03_LIB, "test_stats.py", T03_TEST, "python3 test_stats.py"),
    ("t04", "agg.js", T04_LIB, "test.js", T04_TEST, "node test.js"),
]

# ---------------------------------------------------------------- 改写类 t05-t08

REWRITE = [
    ("t05",
     "智能路由作为大模型应用降本增效的重要抓手，正在成为行业关注的焦点。值得注意的是，"
     "当前市场上的解决方案良莠不齐，亟需一套系统性的评估框架。总的来说，企业在选型时"
     "不仅要关注单价，更要关注端到端的综合成本。综上所述，只有把判定开销、降档风险和"
     "缓存重算三笔账算清楚，才能真正实现成本结构的重塑，从而为业务带来可持续的价值。",
     ["判定开销", "降档", "缓存"],
     "把这段产品介绍改写成一段人话：去掉套话和串联词，只留能验证的说法。"),
    ("t06",
     "随着 Agent 技术的深度融合，工具调用链路的复杂度呈现指数级上升。首先，不同步骤"
     "对模型能力的要求存在显著差异；其次，统一的模型配置会造成明显的资源浪费；最后，"
     "动态调度能够有效提升整体的性价比。值得注意的是，这一过程需要完善的遥测体系"
     "作为支撑，否则难以定位问题。综上所述，智能路由是 Agent 工程化的必由之路。",
     ["工具调用", "步骤", "遥测"],
     "把这段技术说明改写成一段人话：把排比和结论套话拆掉，说清机制。"),
    ("t07",
     "从数据表现来看，该方案在成本控制方面取得了显著成效。值得注意的是，相比基线配置，"
     "其综合成本下降了约百分之七十；其次，在复杂任务上的得分不仅没有下降，反而略有提升；"
     "最后，平均响应延迟维持在可接受区间内。总的来说，这组数据充分证明了该方案的"
     "先进性与可行性，为后续的规模化推广奠定了坚实基础。",
     ["70", "得分", "延迟"],
     "把这段数据描述改写成一段人话：保留数字，去掉评价性套话，标明数字的限定条件。"),
    ("t08",
     "综上所述，智能路由并非简单的模型替换，而是一套涉及判定、锁档与计价的系统工程。"
     "值得注意的是，任何忽略判定成本的做法都是不完整的；其次，长任务场景下的档位"
     "稳定性直接决定了用户体验；最后，缓存的重算损失必须被显式计入账本。总的来说，"
     "只有建立完整的成本核算体系，才能让降本真正落地，而不是停留在宣传口径上。",
     ["判定", "锁档", "缓存"],
     "把这段结论改写成一段人话：拆掉\"不是…而是\"和排比，保留判断，别写口号。"),
]

# ---------------------------------------------------------------- 表格核对 t09-t12

T09_A = """渠道,曝光,点击,转化
抖音,120000,8600,430
小红书,58000,7100,312
视频号,34000,3900,180
B站,21000,2600,120
知乎,15000,1800,74
微博,98000,5200,205"""

T09_B = """渠道,曝光,点击,转化
抖音,120000,8600,430
小红书,58000,7100,322
视频号,34000,3900,180
B站,21000,2400,120
知乎,15000,1800,74
微博,98000,5200,215"""

T10_A = """模型,输入价,输出价
deepseek-v4-flash,0.5,2
deepseek-v4-pro,2,8
qwen3.8-27b,0,0
agnes-3.0-flash,0.8,3
kimi-k2.6,4,16"""

T10_B = """模型,输入价,输出价
deepseek-v4-flash,0.5,2
deepseek-v4-pro,2,9
qwen3.8-27b,0,0
agnes-3.0-pro,0.8,3
kimi-k2.6,3.5,16"""

T11_A = """任务,通过,平均耗时s,花费
t01,2,41.2,0.031
t02,2,38.7,0.028
t03,1,52.1,0.044
t04,2,35.9,0.026
t05,2,61.4,0.052
t06,1,58.3,0.049
t07,2,44.8,0.033
t08,2,47.6,0.038"""

T11_B = """任务,通过,平均耗时s,花费
t01,2,41.2,0.031
t02,2,38.7,0.028
t03,1,52.1,0.044
t04,2,35.9,0.030
t05,2,61.4,0.052
t06,2,58.3,0.049
t07,2,44.8,0.033
t08,2,47.6,0.036"""

T12_A = """服务,端口,状态
cursor-proxy,18790,up
codex-proxy,18791,up
dsh-proxy,18794,down
hermes-proxy,18797,up
l2-engine,18799,up"""

T12_B = """服务,端口,状态
codex-proxy,18791,up
cursor-proxy,18790,up
dsh-proxy,18794,up
hermes-proxy,18797,up
l2-engine,18799,down"""

TABLE = [
    ("t09", T09_A, T09_B, [("小红书", "转化"), ("B站", "点击"), ("微博", "转化")]),
    ("t10", T10_A, T10_B, [("deepseek-v4-pro", "输出价"), ("agnes-3.0-flash", "模型"), ("kimi-k2.6", "输入价")]),
    ("t11", T11_A, T11_B, [("t04", "花费"), ("t06", "通过"), ("t08", "花费")]),
    ("t12", T12_A, T12_B, [("dsh-proxy", "状态"), ("l2-engine", "状态")]),
]


def main():
    if os.path.isdir(FIX):
        shutil.rmtree(FIX)
    tasks = []

    for tid, libname, libsrc, testname, testsrc, cmd in CODING:
        d = os.path.join(FIX, tid)
        w(os.path.join(d, libname), libsrc)
        w(os.path.join(d, testname), testsrc)
        ext = "python" if libname.endswith(".py") else "js"
        prompt = f"""下面是一个能复现失败的用例。跑 `{cmd}` 会失败。

请修复 `{libname}`，让 `{cmd}` 通过。**只能改 `{libname}`，不能改 `{testname}`。**

当前 `{libname}`：

```{ext}
{libsrc}```

`{testname}` 内容（只读，不要改）：

```{ext}
{testsrc}```

输出要求：只输出一个 ```{ext} 代码块，里面是修复后的 `{libname}` 完整内容。不要解释。"""
        w(os.path.join(PROMPT, f"{tid}.md"), prompt)
        tasks.append({
            "id": tid,
            "class": "coding",
            "prompt_file": f"prompts/{tid}.md",
            "workdir": f"fixtures/{tid}",
            "target_file": libname,
            "protect": [testname],
            "accept": cmd,
            "accept_note": "",
            "repeat": 2,
        })

    for tid, src, keep, hint in REWRITE:
        prompt = f"""{hint}

要求：
1. 不许用破折号（——）。
2. 不许用"不是…而是"这种对举句式。
3. 不许出现这些词：值得注意的是、总的来说、综上所述、首先、其次、最后、亟需、赋能、抓手、深度融合、全面提升、良莠不齐、坚实基础。
4. 必须保留这些词或数字：{'、'.join(keep)}。
5. 字数（不含空白）与原文相差不超过 15%。
6. 只输出改写后的正文，不要标题、不要解释、不要代码块。

原文：

{src}
"""
        w(os.path.join(PROMPT, f"{tid}.md"), prompt)
        tasks.append({
            "id": tid,
            "class": "rewrite",
            "prompt_file": f"prompts/{tid}.md",
            "source": src,
            "must_keep": keep,
            "accept": "check_rewrite.py",
            "accept_note": "无破折号、无 banned 词、保留关键词、字数 ±15%",
            "repeat": 2,
        })

    for tid, a, b, gt in TABLE:
        prompt = f"""下面是同一个统计的 A、B 两个版本（CSV，第一列是行名，第一行是列名）。找出所有不一致的单元格。

A：
```
{a}
```

B：
```
{b}
```

注意：
- 只报"值不同"的单元格。行的顺序变化不算差异。
- 某一行的行名本身不同（A 里是 x，B 里变成 y），只报一条：row 填 A 的行名，field 填第一列的表头名。
- 多报、少报都算错。

输出要求：只输出一个 ```json 代码块，内容是 JSON 数组，每项形如 {{"row": "行名", "field": "列名"}}。不要解释。"""
        w(os.path.join(PROMPT, f"{tid}.md"), prompt)
        tasks.append({
            "id": tid,
            "class": "table",
            "prompt_file": f"prompts/{tid}.md",
            "ground_truth": [{"row": r, "field": c} for r, c in gt],
            "accept": "set_equality",
            "accept_note": "差异集合与 ground truth 完全一致，多报少报都算失败",
            "repeat": 2,
        })

    meta = {
        "_说明": "2026-10-18 评测任务集。由 build.py 生成，不要手改。三类各 4 题，全部机器可判。",
        "_已知局限": [
            "改写类题目用的是自造 AI 腔样本，不是真实旧稿；只能测'能不能按约束改写'，不能测长文结构。",
            "表格类用内联 CSV，规模 5-8 行，比真实对账小一个量级。",
            "编码类没有工具调用能力，模型只能整文件重写，测不到'只改一行'的精度。",
        ],
        "tasks": tasks,
    }
    w(os.path.join(BASE, "tasks.json"), json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(f"生成 {len(tasks)} 题")


if __name__ == "__main__":
    main()
