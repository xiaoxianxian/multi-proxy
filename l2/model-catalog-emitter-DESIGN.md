<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Model Catalog Emitter — 设计文档

> 模块：`l2/model-catalog-emitter.js` + `model-catalog-emitter.demo.js`
> 日期：2026-10-09
> 关联：70 号 GUI 零打扰接入 / cc-switch 借鉴 / 69 号仓库级挂账

## 1. 背景

cc-switch 让本地 Agent（Codex / Claude Desktop / Gemini CLI / …）能选择非官方模型，靠**两个动作**：

1. **写 agent 配置文件**（`~/.codex/config.toml` 加 `[model_providers]` + `model_catalog_json` 指针）
2. **生成模型目录 JSON**（`~/.codex/cc-switch-model-catalog.json`，31 字段/模型）← agent 靠这份在 UI 里选模型

18790（codex-proxy）已实测支持 Responses 协议（`POST /v1/responses → 200`，完整 reasoning），
18795（token-policy-bridge）的 `/v1/models` 也返回 17 个模型的精简列表（4 字段：id / object / owned_by / created）。

**缺的是 model catalog emitter** —— 把精简 4 字段补成 31 字段，让 Agent UI 能选。

## 2. 落点

| 层 | 模块 | 状态 |
|---|---|---|
| 协议转换 | `codex-proxy/proxy.js`（18790） | ✅ 已通（Responses 200） |
| 模型枚举 | `tools/token-policy-bridge.js`（18795） | ✅ 已通（17 模型） |
| **模型目录生成** | **`l2/model-catalog-emitter.js`** | **本次新增** |
| 写 agent 配置 + 目录 | `tools/agent-proxy-switch` curator/off 扩展 / 独立 CLI | 门控默认关，§3 |

## 3. 映射规则

| 源（/v1/models） | 目标（cc-switch catalog） | 映射 |
|---|---|---|
| `id` | `slug`, `display_name`, `description` | 默认 = id，可 override |
| `context_window` | `context_window`, `max_context_window` | 默认 128000 |
| `input_modalities` | `input_modalities` | 默认 `['text','image']`（保守全开，可覆盖） |
| — | `priority` | 默认 1000 |
| — | `supported_reasoning_levels` | 默认 4 级（low/medium/high/xhigh） |
| `model_messages` | `model_messages` | 调用方注入，emitter 不重造 |
| 其他 20 字段 | 固定默认值 | 见 `emitModel()` 源码 |

## 4. 非侵入 + 门控

**emitter 是纯函数，绝不写 agent 文件。**

```
CURATOR_CATALOG_EMIT 默认 unset → demo 只生成 + 内存断言，零文件 IO
CURATOR_CATALOG_EMIT=true      → 调用方 CLI 负责写盘到注入目录
```

§3 非侵入红线：adapter / emitter 默认 **绝不写 `~/.codex` / `~/.claude` / `~/.cursor` 等 agent 家目录**。
写盘是调用方职责，默认关。

## 5. 协议验证

```bash
# 18790 已支持 Responses
$ POST 18790/v1/responses  model=agnes-3.0-flash → 200
  返回完整 reasoning + output_text "Hi there! How can I help you today?"
  73 input / 46 output tokens ✅
```

## 6. 冒烟结果

```
$ node l2/model-catalog-emitter.js
# 4 模型 catalog 生成 + 12 断言全绿，输出 JSON 样本

$ node l2/model-catalog-emitter.demo.js
# 对拍 cc-switch 真实 catalog（agnes-3.0-flash, 31 字段）
# 所有非忽略字段值匹配 cc-switch ✅
```

## 7. 风险（§3 非侵入）

emitter 生成 catalog 本身零风险（纯函数）。
**写 `~/.codex/config.toml` + `~/.codex/model-catalog.json` 是 signoff 动作**。
emitter 不碰 agent 家目录，写盘由调用方 CLI 在 `CURATOR_CATALOG_EMIT=true` 时执行，
需维护者 signoff（§3 非侵入铁律 / 69 号挂账 / 70 号 GUI 红线）。
