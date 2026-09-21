---
title: "DeepSeek Harness（DSH）生态接入规划"
status: in-progress
doc_type: integration-plan
confidence: high
last_updated: 2026-09-19
related_code:
    - .dsh/skills/multi-proxy/SKILL.md
    - .dsh/skills/l2-orchestrator/SKILL.md
    - l2/plugin-runtime.js
    - l2/adapter-protocol.md
related_docs:
     - docs/INDEX.md
     - AGENTS.md
     - AGENTS.md
     - docs/02-product/bundle-design.md
---

# DeepSeek Harness（DSH）生态接入规划

## 一、为什么做

- **种子用户 + 官方背书**：DSH（DeepSeek Harness，"一切皆插件"）2026-08-13 开源，
  读与 Claude Code 同源的 `SKILL.md` 格式。收录可获得品牌背书与首批用户。
- **架构天然契合**：本仓 L2 内核（`l2/plugin-runtime.js`）本就是"类 DSH 一切皆插件"设计
  ——插件 `<dir>/index.js` export `init/start/stop/capabilities`，可热插拔，
  与 DSH 的 plugin/skill 理念同构。

## 二、DSH SKILL.md 规范（已查证）

- 一个 skill = 一个文件夹 + 一个 `SKILL.md`，含 **YAML frontmatter（`name` + `description`）** + markdown 正文。
- `description` 规范：**以 "Use when…" 开头**，写清触发场景。
- progressive disclosure：默认只预载 `name` + `description`，正文按需加载。
- 发现目录：DSH 启动时扫描固定 6 个目录（项目级 / 用户级 / 内置）。
  本项目 skill 放 **`.dsh/skills/`**（项目级）。

## 三、接入分层（DS1 / DS2 / DS3）

| 层 | 内容 | 成本/风险 | 状态 |
|----|------|-----------|------|
| **DS1** | 2 个 `SKILL.md`（`multi-proxy` + `l2-orchestrator`）+ `dsh-plugin` GitHub topic 骨架 | 半天 · 零风险 | ✅ 本次完成（见下方"已完成"） |
| **DS2** | 发 npm bundle（`package.json` 加 `dsh.bundle` 字段，对外发布） | 中风险 · 需 DSH 0.2 稳定 | ⏸ 暂缓（09-21 实测：DSH 最新 `v0.1.6-alpha.2`，0.2 未发） |
| **DS3** | 用户实际 `dsh plugin add` 运行 | 高风险 · install guardrail 未修 | ⏸ 暂缓（见风险节，09-21 实核 #1496 来源存疑） |

### option3 收口（2026-09-19）：L2 MCP bridge 落地，DS2 仍为外部阻塞

- **已就绪的消费面**：option3 收口把 L2 编排内核能力经标准 MCP bridge 暴露——
  `l2/mcp-server.js`（JSON-RPC 2.0 over stdio）+ `multi-proxy-manager/routes/mcp.js`（`/api/mcp` 接线），
  工具含 `routeTask` / `decompose` / `orchestrate`，并接 complexity→modelTier 三档路由
  （`agnes=small` / `deepseek=medium` / `qwen=large`，见 `l2/mcp-default-seed.js` + `l2/COMPLEXITY-MODE.md §2.1`）。
  门控 `PROXY_L2_MCP` 默认 `0`（非侵入，关时全 403/拒消息），开 = 显式 opt-in。
  这给 DS2 准备了 L2 侧的"可消费能力面"。
- **DS2 仍是外部阻塞，本期不写 DSH 代码**：DS2（发 npm bundle）的两个前置都未解——
  ① 等 DSH 0.2 发 npm bundle 稳定；② `dsh plugin add` 的 P0 guardrail（#1496）修复前不发包、
  不实际 `dsh plugin add` 到任何 profile。故本期仅在此登记阻塞 + 把 L2 MCP 能力作为 DS2 预备，
  **不写码、不发包、不打 tag**（与 DS1 同纪律）。
- DS3 维持暂缓：同受 #1496 guardrail 阻塞。

### DS1 已完成（2026-09-16）

- `.dsh/skills/multi-proxy/SKILL.md` — 项目总入口导向 skill
- `.dsh/skills/l2-orchestrator/SKILL.md` — L2 编排内核导向 skill
- 两个 SKILL.md 均符合 DSH 规范（`name` + "Use when…" description + 正文）

### `dsh-plugin` GitHub topic —— 骨架（未执行）

> **本次不做**：DSH 0.2 尚未稳定，实际打 topic / 发 npm 包属 DS2/DS3，暂缓。

申请步骤（待 DSH 0.2 稳定后执行）：
1. 在 GitHub 仓库 `xiaoxianxian/multi-proxy` 添加 topics：`dsh-plugin`、`deepseek-harness`、`agent-skill`、`llm-orchestration`。
2. 在仓库 README 加一个 "DeepSeek Harness" 小节，链 `.dsh/skills/` 两个 skill。
3. 视 DSH 收录流程，提交到 `awesome-deepseek-harness` 列表 / 官方 plugin market（如有）。

## 四、风险与暂缓项（诚实标注）

### 风险：DSH 安装 guardrail 未修

- GitHub 讨论 #1496：`dsh plugin add` 装错插件可能导致整个 profile 起不来，无自动诊断 / 回滚。**2026-09-21 gh 实核**：`deepseek-ai/deepseek-harness` 已 `repository has disabled issues`，#1496 已无法定位（疑似过时/重编号，原文据 09-16 记录），社区侧 P0 guardrail 状态待官方重新发布确认。
- **对策**：DS3（实际运行）等 guardrail 修复后再做；DS1/DS2 仅"产出骨架"，不实际安装到任何 profile。

### 暂缓项

- DS2 npm bundle 发布：等 DSH 0.2 稳定 + 包规范确认。**（09-21 实测：DSH 最新 `v0.1.6-alpha.2`，0.2 仍未发）**
- DS3 用户实跑：等 guardrail 修复。**（09-21 实测：#1496 在官方仓库已无法核实，需 DSH 侧重新确证）**
- 实际打 GitHub topic：等 DSH 0.2 稳定（避免在预览版上留噪音）。

## 五、验收标准（DS1）

- [x] 2 个 SKILL.md 落地 `.dsh/skills/`，`name` + "Use when…" description 合规。
- [x] 接入规划文档（本文件）落 `docs/02-product/`，DS1/DS2/DS3 分层 + 风险标注清晰。
- [x] 零发包、零打 tag、零实际 `dsh plugin add`——纯骨架。
