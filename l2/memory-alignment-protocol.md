<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Agent Memory & Capability Alignment Protocol（记忆与能力对齐协议）

> **定位**：L2 开放接入协议的孪生协议，与 `l2/adapter-protocol.md` 并列。
> `adapter-protocol` 管「**任务**互通」——任意 agent 能接活/交活；
> 本协议管「**记忆与能力**对齐」——任意 agent 能**读对方的记忆和配置，拿来完善自己，但不把两边合并成一份**。
> 本协议 **agent-agnostic**：Codex / Hermes / WorkBuddy / Cursor / 自定义 agent，任一实现本协议即可与另一侧互认，无需从零对练。

**状态**：v0 草案（2026-10-02）。首个实施方 = Hermes ↔ WorkBuddy 全局对齐。纯文档，0 代码，热路径 0 diff，未 commit。

---

## 为什么需要它（源自 2026-10-02 实测体感）

两个工具跑同一批活时，体感差不是「模型智商」差，而是**主动性**差。拆开三层：

| 层 | 内容 | 能否跨 agent 复用 |
|---|---|---|
| ① 纪律 | 先自查再问 / 有观点 / 跑完再停 / 签核红线 | 已是数据，两侧人设文件各存一份、口径对齐即可 |
| ② **触发器** | 「⏳ 待办提醒」节：`触发条件：下次提到 X 就主动提醒 Y` | **本协议的主角**——跨 agent 可继承的主动性数据 |
| ③ 模型 | 推理力档位 | 各 agent 自管，不靠协议 |

结论：让一个 agent「站在另一个的肩膀上继续成长」，缺的不是智商，是第②层——**一份带触发条件的待办数据 + 一条「该主动就主动」的规矩**。本协议把这条规矩固化成可照做的契约。

**关键原则（维护者 2026-10-02 拍板）**：
- 记忆**各写各的，不合并成一份**——保证每个 agent 自身的智力/能力不后退（合并会让「各养各的」失去意义）。
- 但要有一个**对称的「读对方 → 完善自己」机制**，且可泛化到任意新加入的 agent。
- 目的：multi-proxy 以后编排 N 个 agent 分工时，「交一个活就活」，不用先花几天给每个 agent 补课。

---

## 一、记忆分层（共享层 vs 私有层）

每个 agent 的记忆分两层，本协议只约束「共享层互读」，不碰「私有层」：

| 层 | 归属 | 谁写 | 谁读 |
|---|---|---|---|
| **共享层（canonical）** | 项目级 `<项目>/MEMORY.md`、项目级 `SOUL.md`/纪律文件 | 所有 agent **共写共读**，补不覆盖、合并删重（见 `workbuddy-hermes-collab` 铁律） | 所有 agent |
| **私有层** | 各 agent 的全局记忆（如 Hermes `~/.hermes/memories/`、WB `~/.workbuddy/MEMORY.md` 全局节） | **各写各的，不合并** | 本协议「读前读对方」时**只读，不搬回写** |

> 私有层可以**吸收**对方的有用条目（标注来源），但**永不覆盖、删除、或合并对方的条目**——那是「完善自己」，不是「接管对方」。

---

## 二、开工前的读取契约（单向拉取）

agent A 在接手一个涉及 agent B 曾参与的话题/项目时，**开工前**执行：

```
1. 定位 B 的共享层 + 触发器条目
   - 项目级：<项目>/MEMORY.md（触发器统一写在各项目 MEMORY 的「⏳ 待办提醒」节）
   - B 的触发器：全文扫「触发条件」字面锚点（工具：tools/memory-sync.cjs v0.1）。
     ⚠️ 别假设「⏳ 节是连续的一块」——实测共享 MEMORY 里编号触发条目之间
     常夹着其它 ## 节（主题交叉追加所致），按节边界解析会静默漏条目。
2. 只拉「B 水位线以上」的增量（见 §四），不全量重读
3. 对每条增量，判定「对我是否也有用」：
   - 有用 → 吸收进 A 的私有层（或该项目的共享层），标注 `来源：<B> <日期> <节锚点>`
   - 纯 B 专属 → 不拉，跳过（保留在 B 侧，不搬）
4. 命中触发器：把 B 侧「触发条件: 下次提到 X 就提醒 Y」中，X 与当前话题重合的条目，
   **主动 surface 给维护者**（不等维护者想起）
```

**纪律**：读取是「完善自己」，不是「同步接管」。对方没改的、对方专属的，都不动。

---

## 三、触发器 = 主动性（跨 agent 继承）

「⏳ 待办提醒」节里的 `触发条件：下次提到 X，就主动提醒 Y` 是**可跨 agent 继承的主动性数据**。任何 agent 读到，就把它注册成自己的「该 surface 的钩子」：

- **继承**：A 读到 B 的触发器 → A 在相关话题出现时**也**会主动提（两个 agent 都能提醒，不会因「只有 B 记得」而漏）。
- **不抢占**：A surface 一条触发器时，不删 B 侧原文（共享层补不覆盖）。
- **过期处理**：触发器带日期戳；维护者完成该事项后，在共享层把对应条目标 `✅ 已收口`，各 agent 读到即不再 surface。

> 这是「主动循环完成任务、不用我提也能想起」的机制化落地——主动性不靠模型灵性，靠这份可继承的数据 + 一条「读到就 surface」的规矩。

---

## 四、水位线（watermark，只拉增量）

每个 agent 记一个「上次读到对方共享层到哪」的水位，**只拉增量、不每次全量重读**（WB 全局 MEMORY 28KB，全量重读会撑爆上下文）：

**水位存储**：共享对齐层 `alignment/<agentA>-to-<agentB>.json`（agentA 读 agentB 的水位；方向性——「我读到你的哪了」属于**读方**，写在读方侧文件里）。最小 schema（v0.1 对齐 `tools/memory-sync.cjs` 实跑）：

```jsonc
{
  "reader": "hermes",              // 谁在记这个水位
  "target": "workbuddy",           // 读到谁
  "targets": [                     // 目标文件列表（可多个：全局 MEMORY + 各相关项目 MEMORY）
    "~/.workbuddy/MEMORY.md",
    "/Users/xiaota/Documents/AI项目/multi-proxy/MEMORY.md"
  ],
  "last_sync": {
    "ts": "2026-10-02",
    "anchor": "pull 2026-10-02: 3 条（新 3）"
  },
  "_mtimeSeen": {                 // 每个目标文件各记一个 mtime（v0.1 按文件判增量）
    "~/.workbuddy/MEMORY.md": 1790950301866.1428
  },
  "absorbed": [                    // 我登记过对方哪些（留痕，防重复吸收；id 稳定=类型|编号|文本前40字）
    { "ts": "2026-10-02", "id": "T:1|1. **文章 #28...", "src": "~/.workbuddy/MEMORY.md",
      "into": "hermes 触发器池", "note": "pull 自动登记" }
  ]
}
```

**增量判定**：每个目标文件 `mtime > _mtimeSeen[该文件]` → 该文件有增量，重扫其触发器条目 + 推进水位；否则跳过。**永不全量重读**。（早期 v0 草案是单 `target_canonical` + 单 mtime；v0.1 因项目级触发器进各自 MEMORY 而升级为 targets 列表 + 逐文件 mtime。）

> 水位是「我」的状态，所以每个方向一个文件：`hermes-to-workbuddy.json`（Hermes 读 WB）+ `workbuddy-to-hermes.json`（WB 读 Hermes）——**这就是 C 档「双向」**。

---

## 五、能力对齐（不止记忆，还包括 skill/纪律）

维护者原话「读对方的**配置和记忆**完善自己」——不止 MEMORY，对方的 **skill / 人设纪律 / 配置约定** 也在对齐范围：

| 对齐对象 | 共享层形态 | 私有层吸收规则 |
|---|---|---|
| 记忆条目 | 项目 `MEMORY.md` | 只读 + 增量 + 标注来源吸收，不合并 |
| 主动性触发器 | 「⏳ 待办提醒」节 | 读到即注册为 surface 钩子（§三） |
| skill / 可复用能力 | 各 agent 的 skills 目录 | 按 `workbuddy-hermes-collab` 的「全局数据审计与同步」流程：审计→优化→同步→验证，**按主题归目录、按工具名适配**，同名不同版取「携带用户最近纠正」那份为 canonical |
| 人设/纪律（SOUL） | 各自 SOUL，口径对齐 | 纪律类逐节对照，已有对应只补缺失项，不整篇复制 |

**边界**：配置类（模型档位、base_url、密钥）各 agent 自管，**不进本协议**——那是各 agent 的私有配置，对齐它们会造成互相打架（正如 2026-10-02 实测：WB 跑 hy3 免费档、Hermes 跑本地 27B + flash 兜底，两边模型档位刻意不同，不该被协议拉齐）。

---

## 六、落地顺序（新 agent 加入 multi-proxy 时）

1. **认共享层**：新 agent 读 `<项目>/MEMORY.md` + 本项目 `AGENTS.md` + 3 份 ADR（与现有 agent 一致的前置）。
2. **建水位**：为新 agent 建 `alignment/<new>-to-<existing>.json`（读每个既有 agent 一份），`last_sync` 置空（首次全量读一次触发器节，之后走增量）。
3. **读触发器**：按 §二 拉各既有 agent 的触发器池，命中的 surface。
4. **补纪律**：人设/纪律按 §五 对照，缺啥补啥。
5. **收口**：维护者完成事项 → 共享层标 `✅ 已收口`，各 agent 停止 surface。

---

## 与 adapter-protocol 的关系（一句话）

`adapter-protocol` 让任意 agent **能接活**（能力声明/健康/任务/结果 四类接口）；本协议让任意 agent **能记事、能主动**（记忆分层/触发器/水位线/能力对齐）。两者正交，可叠加——一个管「手脚」互通，一个管「脑子和主动性」对齐。multi-proxy 编排多 agent 时，L2 公共层同时依赖这两个协议。

---

## 首个实施（Hermes ↔ WorkBuddy，2026-10-02）

- **可执行同步**：`tools/memory-sync.cjs`（v0.1，零 npm，Node>=18）——`report` / `check --topic "词 词"` / `pull`，读 `alignment/<direction>.json` 的 `targets` 列表 + `_mtimeSeen` 逐文件水位。2026-10-02 实测：WB 侧 3 条触发器（跨节不连续）全抓到；pull 首次全量登记、二次命中水位不重复；check 话题命中准确。
- **Hermes 侧**：`workbuddy-hermes-collab` skill 已加「主动继承触发器」机制（开工扫 WB「触发条件」锚点，命中相关话题主动 surface；全局记忆只放指针不放全文防撑爆——维护者 2026-10-02 铁律「全局记忆不是垃圾桶」）。
- **WorkBuddy 侧**：对称 `alignment/workbuddy-to-hermes.json`，targets 指向 Hermes 全局记忆 + 相关项目 MEMORY。
- **当前 WB 触发的 3 条待办**（Hermes 读到即应主动 surface）：
  1. 文章 #28《GEO是不是伪需求》→ 提「迭代/发布文章」时提醒「#28 终读一遍就能发」（⚠️ 量级口径「人效 vs 审核周期」下次改先拍板）
  2. 审核平台黄金集 → 提 Photo-Audit-Demo/审核平台/机审时提醒「下一步起草标注指南 v1（schema+10 示例）→ M1 60 篇标注」
  3. Ollama 僵尸请求血泪坑 → 调 `/v1/chat/completions` 必须显式给 `max_tokens`、客户端 timeout 大于真实生成耗时（27B 给 300s）、真跑前先发秒回探队列、不并发打本地 27B
- **项目级触发器**（v0.1 起）：各项目 MEMORY 的「⏳ 待办提醒」节也是触发器池——首个实例 = multi-proxy `MEMORY.md` 的「L2 内核接入确认」触发器（两方向 targets 均已覆盖）。

## 已知边界与下一步

- **L2 内核机械保证（DEFERRED，2026-10-02 维护者拍板）**：水位线当前是脚本+文件约定；接 L2 `registry`/`bootstrap` 做自动互认/机械推进，等 multi-proxy 测试验收阶段维护者确认再动（项目 MEMORY「⏳ 待办提醒」第 1 条已挂该触发器）。
- **常驻自动化**：「每个会话自动扫触发器」需 cron/automation 兜底，属维护者 验收 项（定 cadence + 触发方式），未拍板前靠 agent 开工纪律（§二）手动跑 `check`。
