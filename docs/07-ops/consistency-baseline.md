<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# docs/07-ops/consistency-baseline.md — 文档声明 vs 代码事实对照

> 用途：外部贡献者 / 评估者用一份表核对「文档怎么说的」和「代码怎么做的」，不用翻全仓库。
> 每条声明都必须可验证（给路径或命令）；发现不符请提 issue，勿默默改文档。
> 最后核对：2026-10-15，HEAD `b234dcc`。

---

## 一、测试基线对照

| 声明位置 | 声明值 | 代码事实 | 一致？ |
|----------|--------|----------|--------|
| README 第十四节 | manager 1458 / codex 159 / claude 174 / opencode 159 / generic 177 / cursor 250 / hermes 77 / dsh 20 / L2 51 demo / shell 11（2026-10-14~15 实测） | 同左，`docs/01-feature-matrix.md` §测试总计 同源 | ✅ |
| `docs/01-feature-matrix.md` 头部 | 2026-10-14 基线 1458/94 suites | 同左 | ✅ |
| `docs/00-codebase-map.md` | 2026-10-15 重写，端口表 + 7 代理 + l2 41 模块 | `ls l2/*.js` 实测 41 非 demo 文件 | ✅ |

复现命令见 `docs/01-feature-matrix.md` §复现命令。已知环境噪音（非产品 bug）：
- jest 全套并发跑时，走真 HTTP 回环的用例在内存争抢下可能 >30s 假红——单跑复绿；
- hermes pytest 需 `--basetemp` 避开部分沙箱环境的 tmp EEXIST；
- 本机无 `bats` binary 时 shell 11 项沿用历史值。

## 二、端口与进程对照

| 端口 | 文档声明（README 第二节） | 代码事实 | 一致？ |
|------|--------------------------|----------|--------|
| 18790 | codex-proxy | ✅ | ✅ |
| 18791 | claude-proxy | ✅ | ✅ |
| 18792 | multi-proxy-manager | ✅ | ✅ |
| 18793 | hermes-proxy | ✅ | ✅ |
| 18794 | cursor-proxy | ✅（默认 127.0.0.1，`BIND_HOST` 可放开） | ✅ |
| 18797 | dsh-proxy（槽位） | manage.sh 预留，按需起 | ✅ |
| 18798 | opencode-proxy | ✅ | ✅ |
| 18799 | generic-openai-proxy | ✅ | ✅ |

已知：macOS 上部分实例可能由 launchd LaunchAgent 托管（`~/Library/LaunchAgents/com.multi-proxy.*.plist`），KeepAlive 会在进程退出后拉起——`manage.sh stop` 停不掉这类实例属预期，需 `launchctl bootout`。

## 三、适配器数量对照

| 声明位置 | 声明值 | 代码事实 | 一致？ |
|----------|--------|----------|--------|
| README 第三节 | 5 个适配器（l1-agent / h3web / aigc / claude / memory-align） | `ls l2/adapters/*.js` = 5 个 | ✅（2026-10-15 补齐，缺口 #14 闭环） |
| 本文件 / 00-codebase-map | 5 个 | ✅ | ✅ |

## 四、已知限制（对外版本）

| # | 限制 | 影响面 | 状态 |
|---|------|--------|------|
| 1 | manager `lib/forward.js` axios 15s + 100MB 全缓冲 | 大文件/长流式转发 | 当前零调用方，触发时再修 |
| 2 | codex-proxy 120s + pipeTo | 超长流式 | 同上 |
| 3 | hermes-proxy 无 E2E 测试 | 集成风险 | 待补 1 个 pytest E2E |
| 4 | `tools/verify/verify.ps1` 未经真机自测 | Windows 验收路径 | 需一台真 Windows 回传报告 |
| 5 | moonshot 上游账号无模型权限（404 Permission denied） | 该 provider 不可用 | 账号侧问题，非代码缺陷；ledger 证明从未调用成功 |
| 6 | M6 需 100 行真实 Cursor 样本 | routing_feedback 数据不足 | 待真实使用积累，脚本喂数据视为污染拒用 |

## 五、内部评审资产的说明

公开仓库不含内部过程资产（评审报告 / 风险登记册 / 工作队列）。对外只保留本文件 +
`docs/01-feature-matrix.md` + `docs/00-codebase-map.md` 三份可验证基准。
如你需要某份内部文档的对外脱敏版，请提 issue 说明用途。
