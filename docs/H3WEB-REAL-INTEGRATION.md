// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

# 真实 h3web 接入 — 验证计划与决策备忘

> 状态：接线代码已完整实现 + 已测试，**仅门控关 + 缺真服务**。本文是「维护者侧起真服务后」的验证计划 + 可独立跑的探测脚本，并附 §3 其余真·未建项的轻量决策备忘。
> 创建：2026-10-09（STATUS-REPORT §3.1 #4「真实 h3web / AIGC 接入」的落地推进）

---

## 1 · 接线代码现状（已实读，证明"非代码缺口"）

| 层 | 文件:行 | 内容 |
|----|---------|------|
| executor 注册 | `l2/executor-bind.js:95-110` | h3web BINDING_DEF：`adapterId:'h3web'`、`envName:'PROXY_H3WEB_PORTS'`、默认 `[8731,8732]`、轮询 `pollMs/maxTries` 可配 |
| 真实 adapter | `l2/adapters/h3web-adapter.js` | `H3webAdapter`：健康 `GET /`、提交 `POST /api/gen`、故事板 `POST /api/storyboard`、状态 `GET /api/status/:id`、便捷 `run()` 提交+轮询；**零依赖**（仅 node http/net）、端口动态探测、字段白名单透传 |
| 替身 | `l2/mock-h3web.js` | 模拟 h3web 最小后端（同契约），供单测验证透传 |
| demo | `l2/adapters/h3web-adapter.demo.js` / `h3web-port-discovery.demo.js` | 已写，验证 adapter 契约与端口探测 |
| 门控 | `l2/executor-bind.js:54-59` | 三档 text-tier 门控 `PROXY_TIER_BIND`（默认 0）；executor 总开关 `PROXY_EXECUTOR_BIND`（默认 0） |
| 测试 | `multi-proxy-manager/tests/unit/executor-bind.test.js` | **21/21 PASS**（mock 下游真跑往返，含 h3web tier） |

**结论**：h3web 接入不是"待写"，是"已建 + 已测 + 仅门控关 + 从未对真 :8731 round-trip"。STATUS §3.1 #4 写"adapter 仅 mock 验证"应修正为"adapter 已实现+已测，仅缺真服务 round-trip"。

---

## 2 · 真实接入 round-trip 步骤（前置：起真 h3web :8731）

### 2.1 前置检查
- 本地 h3web 服务在 `:8731` 监听（`lsof -iTCP:8731 -sTCP:LISTEN` 有输出）。
- 当前实测（2026-10-09 19:47）：**`:8731` 未监听、无 h3web 进程** → 此步为维护者侧动作。

### 2.2 用探测脚本验证（秒级、零副作用）
```bash
cd /Users/xiaota/Documents/AI项目/multi-proxy
node scripts/h3web-roundtrip-probe.js            # health 模式：探活 + 端点契约嗅探
# 期望：✓ h3web 在 :8731 探活成功；POST /api/gen -> {job_id,...}
```

### 2.3 真 round-trip（耗时长，显式开启）
```bash
node scripts/h3web-roundtrip-probe.js --gen      # 提交最小竖屏 job 并轮询到 done
# 竖屏 768×1344 steps=8 约 15min（h3web 实测）；脚本每 POLL_MS 打印一次状态
```

### 2.4 翻门控接进 L2 executor（生产默认开）
```bash
cd /Users/xiaota/Documents/AI项目/multi-proxy/l2
PROXY_EXECUTOR_BIND=1 \          # 总开关：stub -> 真执行
PROXY_H3WEB_PORTS=8731 \         # 指向真 h3web（默认 [8731,8732] 也会自动探测到）
PROXY_TIER_BIND=1 \              # 可选：同时启用三档 text-tier（agnes/deepseek/qwen）
node executor-bind.js
```
> 不翻 `PROXY_EXECUTOR_BIND` 时，executor 默认 `null` = 仅路由、零外发，是安全的稳态终点。

### 2.5 决策闸门（翻门前确认）
- [ ] 真 h3web :8731 已起且 `health` 模式脚本探活通过
- [ ] `--gen` 真 round-trip 跑通（job 到 `done`，字段透出正确）
- [ ] 真服务会消耗本地 GPU/内存：跑 benchmark 时先暂停 Ollama 等争抢任务（见项目纪律）
- [ ] 翻 `PROXY_EXECUTOR_BIND=1` 后真外发，属不可逆生产变更 → 建议先单 workspace 灰度

---

## 3 · 其余真·未建项（§3.1 #7/#8/#D）轻量决策备忘

> 以下三项**不擅自实现**（v2 大项或需定边界），仅给维护者拍板的决策备忘。

### #7 多租户 / Portico 控制面
- 性质：v2 / 企业版控制面，当前未建。
- 建议：v1 冻结不进；v2 起前需先定「租户隔离边界（数据/路由/计费）」+ Portico 控制面选型。
- 阻塞：需维护者定 v2 范围与 Portico 集成方式，非代码缺口。

### #8 前端测试覆盖
- 性质：dashboard / sessions 前端目前手测为主，无自动化冒烟。
- 建议：v1 后补「关键路径冒烟」（登录→看板→中起任务→abort→resume），用 Playwright 或轻量 DOM 测试；当前优先级 P1。
- 阻塞：需先定前端测试框架（项目已有 6 个 Playwright .ts 但非主链路）。

### #D savings-gateway 价格进 route 排序 + 排行榜
- 性质：二期 YAGNI 设计，当前仅 shadow 模拟 delta。
- 建议：v1 不进（保持 shadow 观测态）；若维护者拍板进 v1，则需补「价格表接入 + 排序权重 + 排行榜落盘」三块，工作量中等。
- 阻塞：纯维护者决策（成本/价值权衡），无代码缺口。

---

## 4 · 本文件结论
- h3web 接入：**已建 + 已测**，剩「起真服务 + 翻门控」两步，均有脚本/runbook 可复制。
- #7/#8/#D：**非代码缺口**，是 v2 范围或维护者决策，不擅自实现。
- 全部 shadow 能力（M6 / L2 executor / savings-gateway / h3web）均已建+已测+已接线，剩的是翻门控决策，均有 runbook。
