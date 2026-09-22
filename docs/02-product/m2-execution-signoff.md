# M2 执行层 sign-off：Provider 故障隔离「执行态」

> 状态：**2026-09-22 代码落地 + 24 测试通过，待老板 sign-off 是否上线 + 是否 flip enabled**
> 锚点：`multi-proxy-manager/lib/provider-isolation-executor.js`（424 行 kernel）
> 参照：与 `l2/alert.js`（304 行）同构的「门控 + 可插拔 + 非侵入」内核

---

## 一、执行层语义

### 角色定位

| 层 | 模块 | 职责 | 门控 |
|---|---|---|---|
| 判定层 | `provider-health.js` | record 失败 → unhealthy → `isolateDelayMs` 后试探 → `listIsolated()` 产出建议清单 | 恒执行 |
| **执行层（本次）** | `provider-isolation-executor.js` | 消费 `listIsolated()` 建议清单，按门控决定是否**真标隔离** | `PROXY_HEALTH_ISOLATE` 默认关 |
| 可注入 executor | 调用方 / demo / `enabled-flip` 缝 | 真执行动作：写 sidecar / flip `enabled` / 发通知 | opt-in + sign-off |

### 执行态三级

| 级别 | 条件 | 行为 | 后果 |
|---|---|---|---|
| **observe（默认）** | `PROXY_HEALTH_ISOLATE` 未设 | `plan()` 永远做 → 建议进内存 `markers[]`，`applied: false`，**零 fs 写入** | 零风险 |
| **degraded（门控开 + 无 executor）** | 门控开但未 `registerExecutor` | `plan()` 永远做 → `degraded='no-executor'`，`applied: false`，**零 fs 写入** | 零风险（非侵入退路） |
| **真执行（门控开 + 活跃 executor）** | 门控开 + `registerExecutor('writeMarkers')` | `plan()` → `dispatch()` → `commit` → `.tmp→rename` 原子写 `~/.multi-proxy-manager/provider-isolation.json` | 独立 sidecar，**绝不改 providers.json / flip enabled** |

### 与 alert.js 的异同

| 维度 | alert.js | provider-isolation-executor.js |
|---|---|---|
| 判定函数 | `evaluate(signal)` | `plan(rec)` |
| 执行核心 | `emit(signal, opts)` | `emit(rec, opts)` |
| 可插拔 sink | `registerSink(name, fn)` | `registerExecutor(name, fn)`（别名 `registerSink`） |
| 落盘 | `alert-events.jsonl`（逐行 append + dedupe + rotation） | `provider-isolation.json`（按 providerId upsert + `.tmp→rename` 原子 + `.bak`） |
| 幂等机制 | `dedupKey` 去重 | `stableKey`（排除 `isolatedAt/viaExecutor/applied` 等瞬时字段） |
| 门控 env | `PROXY_HEALTH_ALERT`（默认关 = 只 `alert-events.jsonl`） | `PROXY_HEALTH_ISOLATE`（默认关 = 只内存 markers） |
| cooldown | `dedupeKeys` Map | `cooldown` Map（同 providerId 窗口内只派发一次） |
| 生产接线 | `l2/alert.js` / `routes/alert.js` | **无热路径**（调用方经 `listIsolated()` 产出后 `run(list)` 喂入） |

---

## 二、门控设计

### 两把钥匙原则

门控开 **≠** 真执行。真执行需要：

1. `PROXY_HEALTH_ISOLATE=1`（门控 key）—— 允许 executor 运行
2. `registerExecutor('writeMarkers')`（另一把钥匙）—— 让 executor 活跃

缺任一 → 退化为 `degraded: no-executor`（门控开但无活跃 executor）或 `observe`（门控关），两者均**零 fs 写入**。

### 门控权在内核

`emit()` 的 observe 判定发生在**内核内部**（门控读 env），`persist:true` 选项**不能绕过**。这与 `alert.js` 同构：`emit()` 的 sink 门控在内核，调用方 `persist` 选项无效于 observe 态。

---

## 三、observe ↔ 执行切换流程

```
# 默认（observe）：门控关，执行层只建议不执行
PROXY_HEALTH_ISOLATE=0   # 或不设
provider-health 的 record → provider-health.listIsolated() → 只产建议（内存 markers）
provider-isolation-executor.run(list) → observe=true, applied=false
~/.multi-proxy-manager/provider-isolation.json 不写或仅 observe 时不写

# 切到执行：门控开 + 显式注册 executor
PROXY_HEALTH_ISOLATE=1
provider-health 的 record → provider-health.listIsolated()
provider-isolation-executor.run(list) → observe=false, executed=true, applied=true
~/.multi-proxy-manager/provider-isolation.json 原子写入（.tmp → rename）
旧文件自动 backup 到 provider-isolation.json.bak
```

### 回滚路径

| 场景 | 操作 | 效果 |
|---|---|---|
| 撤销观察中的建议 | `rollback(providerId)` | 清内存 markers + 门控开则重写 sidecar 移除 |
| 窗口到期自愈 | `heal()` | 自动检测过期（`now >= unhealthyUntil`）→ 解除 |
| 紧急停止执行 | 设 `PROXY_HEALTH_ISOLATE=0` | 立即回到 observe，不再写盘 |
| 删除所有记录 | `reset()` | 内存 markers/cooldown/lastWritten 全清 |

---

## 四、测试覆盖

| 测试文件 | 行数 | 测试用例数 | 状态 |
|---|---|---|---|
| `multi-proxy-manager/tests/unit/provider-isolation-executor.test.js` | 360 | 24 | ✅ 全绿 |
| `multi-proxy-manager/tests/demo/provider-isolation-executor.demo.js` | 215 | 8 | ✅ PASS 8/8 |

### 测试覆盖矩阵

| 场景 | 测试 | 断言 |
|---|---|---|
| 门控关 = observe，`applied: false` | `门控 · observe 默认 › 门控关 → 即使 persist:true 也只观察` | `applied: false`, `fs.existsSync: false` |
| 门控开 + executor → 真执行 | `门控开 + 注入 executor › writeMarkers + 门控开 → 写入临时 sidecar` | `executed: true`, `flippedEnabled: false` |
| 幂等（重复 emit 不重复写） | `idempotency › 同稳定键重复 emit → 不重写盘` | `mtimes` 不变, `applied: false` |
| executor 抛错不崩 | `executor 抛错 › 一个 executor 抛 → 记录失败但仍派发其它` | `threw: false`, `ok: false` catch |
| cooldown 窗口内去重 | `cooldown › 窗口内第二次 → deduped=true` | `deduped: true` |
| 超 cooldown 重新执行 | `cooldown › 超 cooldown + 内容变化 → 重新执行` | `deduped: false, applied: true` |
| 回滚 | `rollback › 门控关 → 只清内存不写盘` / `门控开 → 重写 sidecar` | `removed: true` |
| 高后果 opt-in 缝 | `flip providers.json › 默认不注入 → 永不 flip` | `flipped=0` |
| 非侵入（生产路径零污染） | 全部测试 | 仅写 `/tmp/` 临时路径 + sidecar |

---

## 五、providers.json 写入决策

### 默认行为：不写 `providers.json`

| 动作层 | 写入目标 | `enabled` 影响 |
|---|---|---|
| `writeMarkers` 内置 executor | `~/.multi-proxy-manager/provider-isolation.json`（**独立 sidecar**） | `flippedEnabled: false`（标记显式声明）**绝不 flip** |
| `enabled-flip` opt-in 缝 | `~/.multi-proxy-manager/provider-isolation.json` sidecar 扩展（`flippedEnabled: true`） | 需 sign-off + 显式 `ctx.flipEnabled` 注入 |

### 为什么不直接 flip `providers.json`

1. **providers.json 是路由引擎的权威数据源**：误禁用任何 provider 会全局重排路由（D8 已证：双 guard 下 round-robin 非写盘，但 flip enabled 是路由引擎真实行为）
2. **高后果**：一次误 flip 可让某 provider 完全不可用，影响所有依赖该 provider 的上游流量
3. **不可回滚**：`providers.json` 无 `.bak`（session-store.js 无 backup），flip 后需人工介入
4. **sidecar 隔离**：`provider-isolation.json` 是独立的隔离标记文件，路由引擎读它时可选择跳过（如 `findProviderByType` 加 `isIsolated` 过滤），但**不自动 flip providers.json**

---

## 六、需老板 sign-off 的点

### 1. 是否开启 `PROXY_HEALTH_ISOLATE`（执行层门控）

- **现状**：代码已落，默认 `observe`（门控关），生产无任何影响
- **风险**：门控开 + `registerExecutor('writeMarkers')` 后，`listIsolated()` 产出的每条建议**会原子写入侧边车**。若 provider-health 误判，会错误隔离（但**不路由**，仅标记）
- **回退**：立即设 `PROXY_HEALTH_ISOLATE=0` 或 `PROXY_HEALTH_ISOLATE=1 node ... -s`（sidecar 不影响路由）
- **建议**：初期仅 observe，积累足够 `listIsolated()` 数据后再开执行层
- **需拍板**：是否现在开 + 开在哪些环境

### 2. 是否需要 `enabled-flip` 高后果缝

- **现状**：`flippedEnabled: false` 为硬默认，任何 executor 必须**显式**设置 `flippedEnabled: true` 才会标记
- **风险**：若未来 executor 注入 `ctx.flipEnabled`，会**直接写 providers.json 的 enabled 字段**——高后果
- **建议**：`enabled-flip` 独立 sign-off，需路由引擎支持 + 回滚预案（providers.json `.bak` + `rollback()` 支持）
- **需拍板**：是否做 + 做什么级别（只标记 / 只 skip 路由 / 完全 flip enabled=false）

### 3. 是否接入热路径

- **现状**：执行层**不接入任何热路径**（无 `routes/` / `lib/` 热路径调用）
- **风险**：接入热路径 = provider-health 每次 `record()` 后自动调用 `executor.run()` → 需要调度
- **建议**：接 `cron` 定时调用（每分钟），而非热路径自动触发
- **需拍板**：是否接入 + 接入方式（cron / 热路径 / 管理台按钮）

### 4. providers.json `.bak` 机制

- **现状**：`session-store.js` 无 `.bak`（`providers.json` 用原子 write 无 backup）
- **建议**：若 `enabled-flip` 要 flip `providers.json`，需加 `.bak` + rollback 能力
- **需拍板**：是否补 `providers.json` backup 能力

---

## 七、回归测试

| 步骤 | 基线 | 实际 | 状态 |
|---|---|---|---|
| `npx jest`（全量回归） | 722/722（45 suites） | **746/746（46 suites）exit 0，0 回归** | ✅ |
| `npx jest provider-isolation-executor` | N/A | 24/24 passed | ✅ |
| `node tests/demo/provider-isolation-executor.demo.js` | N/A | 8/8 PASS | ✅ |
| 生产 `~/.multi-proxy-manager/provider-isolation.json` | 不存在 | 不存在（非侵入确认） | ✅ |

> 全量回归 746 = 基线 722 + 新测试 24（单 suite）；46 suites = 旧 45 + 新 1。0 回归。demo 全程写 `/tmp/` 侧边车 + 临时 providers.json，**不碰生产** `~/.multi-proxy-manager/providers.json`。

---

## 八、新建 / 修改文件清单

| 文件 | 行数 | 状态 |
|---|---|---|
| `multi-proxy-manager/lib/provider-isolation-executor.js` | 424 | ✅ 新建（kernel） |
| `multi-proxy-manager/tests/unit/provider-isolation-executor.test.js` | 360 | ✅ 新建（24 tests） |
| `multi-proxy-manager/tests/demo/provider-isolation-executor.demo.js` | 215 | ✅ 新建（8 scenarios）|
| `docs/02-product/m2-execution-signoff.md` | — | ✅ 本文档 |

### 未修改的生产文件（非侵入铁律）

- `multi-proxy-manager/lib/provider-health.js` — 纯记录层，零改动
- `multi-proxy-manager/lib/session-store.js` — 原子写入模式参考，零改动
- `multi-proxy-manager/routes/*` — 路由层，零改动

```
git add -A multi-proxy-manager/lib/provider-isolation-executor.js \
  multi-proxy-manager/tests/unit/provider-isolation-executor.test.js \
  multi-proxy-manager/tests/demo/provider-isolation-executor.demo.js \
  docs/02-product/m2-execution-signoff.md
# 不 commit / 不 push（父代理统一处理）
```
