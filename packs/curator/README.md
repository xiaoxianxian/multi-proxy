<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Curator Pack（packs/curator/）

把 Raven 的 agent 级 RSI（改写 harness 而非权重）思路，落到 multi-proxy 已有的 `l2/token-policy.js` 5-hook 扩展面上，做成**默认关**的 curated pack。

设计稿：`docs/10-initiatives/06-curator-pack.md`；执行版：`docs/10-initiatives/07-curator-pack-TASKS.md`。

## 诚实边界（必读）
- **默认关**：`pack.yaml` 的 `enabled: false`，engine 不 enable 时 5 个 hook 的 `apply(...)` 结果数恒为 0，不触发任何行为变更、不触 net、不写 agent 文件。
- **未接入生产热路径**：截至本 README，无任何业务代码调用 `apply()`（仅 `token-policy.demo.js` 与 jest 单测 `token-policy.test.js` 18/18 + `curator-pack.test.js` 15/15，2026-09-28 全绿、核心 0 改动）。要产生**真实** token 节省，需把 `apply()` 接入 `codex-proxy/proxy.js` 转发路径——属另一条线（07 边界 5 / `03-token-control-plane.md` / `02-L2热路径改造计划.md`），本 pack 不含。
- **实验性**：Raven Curator 作者自陈无跨场景统计验证；本 pack 是「方向跟」，验收只用模拟场景。

## 启用 / 回滚
```js
const { createCurator } = require('./packs/curator/curator-engine.js');
const c = createCurator();          // 默认关：全部 enabled=false
c.enable();                          // 翻转 refs[i].enabled = true（非重新 applyPack，会抛 policy already registered）
// 改策略（受限、机械 assert 校验）：
c.applyChange('onHistory', 'keepLastN', 8);   // 合法安装；越界/类型错被拦下不安装
const snap = c.snapshot();           // M4 快照；c.restore(snap) 回滚
c.disable();                          // 关
```

## 风险
- handler 抛错被 `apply` 吞成 `{ok:false}`（`token-policy.js:167-170`），单测须断言 handler 返回值而非「不报错」。
- `applyChange` 只允许改 `policies/*.js` 暴露的 params 数值（`CHANGE_VALIDATORS`），不改 hook 结构、不碰核心通用层（prompt-cache / schema 懒加载 / 历史压缩 / 分级路由）。
