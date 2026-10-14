<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Agent 覆盖路线图（2026-10）

> 本文回答两个问题：**外面现在哪些 coding agent 最热**，以及 **multi-proxy 按什么顺序接入它们**。
> 所有市场数据均标注来源与抓取日期；覆盖状态以本仓库代码为准，每季度复核一次。

---

## 一、市场格局（2026-10 抓取）

三个独立口径交叉验证，结论一致：终端/自主型 agent 是主战场，Claude Code 与开源 opencode 双极领先。

| 口径 | 排名 | 来源 / 日期 |
|------|------|------------|
| GitHub 星数 | opencode 21.2万 > Claude Code ~15万 > Codex CLI 12.8万 > Pi 11.5万 > Gemini CLI 10.7万 | GitHub API 快照，2026-10-06 |
| 主力工具市占率 | Claude Code 29.4% > Copilot 22.7% > Cursor 13.1% > Codex 11.8% | First Page Sage 跟踪，2026-10 |
| 公开代码产出（可归因 commits/PRs） | Claude Code 132.9M（约占 80%）> Cursor 12.9M > Replit Agent 8.9M > Codex 5.1M PRs | amplifying.ai Coding Agents Index，2026-09-28 快照 |

同期影响判断的三个事件：

- **Gemini CLI 个人版服务于 2026-06-18 终止**，继任者 Antigravity CLI 闭源（Gemini CLI 本体仍以 Apache-2.0 服务于企业 Code Assist）。
- **Cognition（Devin）完成 20 亿美元 E 轮，估值 480 亿美元，并收购 Windsurf**——资本市场认定该赛道可容纳多个数百亿美金级玩家（SegmentFault AI 日报，2026-10-12）。
- **Codex CLI 全面开源（Apache-2.0）并重构为 Rust 后端**，成为三家里唯一有原生 Windows 沙箱的（blog.piax.org，2026）。

中文市场（供参考，非本路线图接入对象）：Trae（字节，个人完全免费，官方称注册用户破 600 万）、腾讯 CodeBuddy（多模型自由切换 + SPEC 驱动）、阿里通义灵码（Qwen 生态）、百度文心快码 Comate。共同点：协议封闭或 IDE 深度集成，第三方代理空间有限。

---

## 二、覆盖矩阵与接入顺序

multi-proxy 现有代理：**codex-proxy（Codex CLI）· claude-proxy（Claude Code）· cursor-proxy（Cursor）· hermes-proxy（Hermes）· dsh-proxy（DeepSeek Harness）**。

| 优先级 | Agent | 热度依据 | 协议 | 接入路径 | 状态 |
|--------|-------|---------|------|---------|------|
| P0 | **Claude Code** | 市占/产出双第一 | Anthropic `/v1/messages` | 复用 codex-proxy 已实现的 messages 协议路径（含 `anthropicBaseUrl` 逃生口），新增 claude-proxy | ✅ 已完成（2026-10-14） |
| P1 | **opencode** | 星数第一（21.2万），MIT，模型无关 | OpenAI 兼容 + 自定义 provider | 原生支持自定义 base_url；proxy 增量在成本台账/熔断/统一面板 | 规划中 |
| P2 | **Cline / Aider / OpenHands** | 58k / 44k / 90.8k 星，开源阵营装机量大（Cline 500万+、Aider 680万+ 安装） | 均为 OpenAI 兼容 | **一个通用 OpenAI 兼容适配器批量覆盖** | 规划中 |
| P3 | Roo Code / Goose | 榜上有名，开源 | OpenAI 兼容 | 随 P2 适配器顺带覆盖 | 观望 |
| 暂缓 | Gemini CLI / Antigravity | 10.7 万星，但个人版已停 | Google genai 私有协议 | 协议改造成本高、受众收缩 | 暂缓 |
| 不做 | GitHub Copilot Agent | 市占 22.7% | IDE 深度集成、封闭 | 无可拦截的本地 API 边界 | 不做 |
| 不做 | Trae / CodeBuddy / 通义灵码 等 | 国内热度高 | 封闭 | 协议封闭且主打免费，付费代理需求弱 | 不做 |
| 研究 | Orca（91k 星） | 多 agent 并行工作区 | — | 与 L2 编排层定位重叠，作对标研究对象而非接入对象 | 研究中 |

### 排序逻辑

1. **Claude Code 排 P0**：市占与产出双第一；Anthropic messages 协议在本仓库已有生产级实现（协议转换、熔断、成本台账全是现成的），改造成本最低；上游侧 DeepSeek / Moonshot 均提供 `/anthropic` 兼容端点，接入即有便宜可省。
2. **opencode 排 P1 而非 P0**：星数虽第一，但它原生支持任意 OpenAI 兼容 base_url——"能连"不是痛点；multi-proxy 的增量价值（统一成本视图、熔断、一键切换、管理面板）要作为卖点讲清楚，而不是作为必需品。
3. **OpenAI 兼容三件套合并为一个适配器**：Cline / Aider / OpenHands 的 LLM 配置方式完全一致（base_url + api_key + model），符合本仓库"参数驱动自动生成解析逻辑"的设计原则，一个适配器覆盖三家，边际成本趋近于零。

---

## 三、接入架构约定

新增代理统一遵循现有分层，不搞特例：

```
Agent（任意形态）──▶ 对应 proxy（L1 网关）──▶ 上游 provider（多家 + 熔断 + 成本台账）
                          │
                          └── 统一接入 manager（18792）看板 / 健康 / 进程管理
```

- **协议分两类适配**：OpenAI 兼容系（chat/completions）走通用适配器；Anthropic 兼容系（messages）走 codex-proxy 已验证的协议路径。每家 agent 只写薄适配层，不重写网关。
- **上游端点优先级**：优先选用上游官方 `/anthropic` 或 `/v1` 兼容端点，避免二次转换损耗。
- **验收标准**：新 proxy 必须带 node:test 单测 + 纳入 `tools/regression-all.sh` + FUNCTIONS.md 同步登记，缺一不合并。

---

## 四、复核机制

- 每季度重跑一次星数/市占抓取，更新 §一；优先级随市场变化调整，调整记录写进本文末尾的变更日志。
- 本文状态字段（🎯/规划中/观望/暂缓/不做）与 FUNCTIONS.md 的代理清单保持同步。

## 变更日志

- 2026-10-14：初版。市场数据抓取于 2026-10-06 ~ 2026-10-13；确定 P0=Claude Code、P1=opencode、P2=OpenAI 兼容三件套。
- 2026-10-14：P0 落地。claude-proxy（18791）交付——174 例 jest 全绿（14 套件同构拷贝 codex-proxy + `model-alias.test.js` 15 例新增）；真机烟测通过：`claude-sonnet-4-5` 经别名映射为 `deepseek-v4-pro` → DeepSeek `/anthropic/v1/messages` 真实返回 OK（87 in / 24 out，Anthropic 协议形状完整）；已纳入 `manage.sh` 与 `tools/regression-all.sh`。接入方式：`ANTHROPIC_BASE_URL=http://127.0.0.1:18791`。
