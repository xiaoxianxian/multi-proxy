---
title: "DeepSeek Harness（DSH）生态接入规划"
status: in-progress
doc_type: integration-plan
confidence: high
last_updated: 2026-09-16
related_code:
    - .dsh/skills/multi-proxy/SKILL.md
    - .dsh/skills/l2-orchestrator/SKILL.md
    - l2/plugin-runtime.js
    - l2/adapter-protocol.md
related_docs:
    - docs/INDEX.md
    - AGENTS.md
    - AGENTS.md
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
| **DS2** | 发 npm bundle（`package.json` 加 `dsh.bundle` 字段，对外发布） | 中风险 · 需 DSH 0.2 稳定 | ⏸ 暂缓 |
| **DS3** | 用户实际 `dsh plugin add` 运行 | 高风险 · guardrail 未修 | ⏸ 暂缓 |

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

- GitHub 讨论 #1496：`dsh plugin add` 装错插件可能导致整个 profile 起不来，
  无自动诊断 / 回滚，社区正在修 P0 guardrail。
- **对策**：DS3（实际运行）等 guardrail 修复后再做；DS1/DS2 仅"产出骨架"，不实际安装到任何 profile。

### 暂缓项

- DS2 npm bundle 发布：等 DSH 0.2 稳定 + 包规范确认。
- DS3 用户实跑：等 #1496 guardrail 修复。
- 实际打 GitHub topic：等 DSH 0.2 稳定（避免在预览版上留噪音）。

## 五、验收标准（DS1）

- [x] 2 个 SKILL.md 落地 `.dsh/skills/`，`name` + "Use when…" description 合规。
- [x] 接入规划文档（本文件）落 `docs/02-product/`，DS1/DS2/DS3 分层 + 风险标注清晰。
- [x] 零发包、零打 tag、零实际 `dsh plugin add`——纯骨架。
