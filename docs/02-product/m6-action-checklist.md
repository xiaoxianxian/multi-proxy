# M6 智能路由 · 行动清单（D4-D8 真实状态 + 价格基线初稿）

> 状态：**2026-09-16 从代码实核重建**（非路线图摘要）
> 锚点：`cursor-proxy/src/routing/` + `src/server/handlers/chatHandler.ts`
> 铁律：不写 DB、不碰热路径、不产生真实 API 消费、不改 pricing 代码（定价是老板决策）

---

## 一、D1-D8 真实状态（git + 代码实核）

| # | 依赖项 | 状态 | commit/证据 |
|---|--------|------|-----------|
| D1 | 引擎核心 4a/4b/4c + 默认四层 | ✅ 完成 | `routeEngine.ts` / `taskClassifier.ts` / `ruleEvaluator.ts`，111 测试 |
| D2 | 影子观测层 routing-shadow | ✅ 完成 | `routing-shadow.ts` + `chatHandler:205`，`PROXY_ROUTING_SHADOW=1` 只观测 |
| D3 | ① 安全不变式测试 | ✅ 完成 | `chat-handler-shadow.test.ts`：on/off 上游逐字节一致 |
| **D4** | **语义决策 override vs failover-only** | ✅ 拍 C，代码已落 | `PROXY_ROUTE_OVERRIDE=1`（默认关）+ `getOverrideLog()` 审计；翻 1 属老板决策 |
| **D5** | **DB model 名 ↔ fallbackChain 对齐** | ✅ **代码已落** | `chatHandler.findProviderByType`（引擎名→type，不写 DB）+ `DEFAULT_ROUTE_CONFIG` 真名对齐；**待老板写 DB enabled + push** |
| **D6** | **4d 健康信号接线（D6-a 完成/D6-b 卡 D4）** | ✅ | `loadEnabledProviderConfigs`（D6-a，热路径零改动）；D6-b（健康决定真实路由）等 D4 翻 override |
| D8 | getNextProviderIndex 生产隐患证伪 | ✅ 证伪（双 guard） | L20-21 + `findProviderConfig` L38 双重 guard，非 round-robin 不写 rr_index |
| D7 | live 回归测试 | ✅ **已实证** | 跑完删探针，1 条 coding 请求 → deepseek 上游 HTTP 200 / 162ms，上游回 `model=deepseek-v4-pro`（密钥不打印） |
| D7-pre | 修 chat-handler-shadow 路由轮转耦合 | ✅ 已修 | `beforeEach` 钉 `routing_mode='priority'`，确定性两解析同 provider |

**结论：D1-D8 代码全部落地并测试。剩 2 项老板决策（见下）+ 1 项价格基线（本文档给初稿，见 §三）。**

---

## 二、两个老板决策项（代码已就位，待拍 + 待 push）

### 决策 1（D5）· 写 DB：enable ollama qwen3.8:27b-mlx provider
- **现状（2026-09-16 实核 `data/proxy.db`）**：`qwen3.8:27b-mlx`（provider_id=ollama，base_url=http://127.0.0.1:11434/v1）**`enabled=1`，已在库，无需动作**。
  - 4 个 provider 全部 `enabled=1`：DeepSeek-Test / agnes-2.5-flash / qwen3.8:27b-mlx / kimi。
- **前置确认（已完成，只读实测）**：ollama 在跑（PID 813，端口 11434 LISTEN）；H3 服务未起（8731/8732 无 LISTEN，仅有 H3 权重下载进程，非服务，不冲突）；内存 free 43%。
- **结论：决策 1 已满足。无需写 DB。**

### 决策 2（D4）· 翻 override 灰度：`PROXY_ROUTE_OVERRIDE=1`
- **现状（2026-09-16 实核）**：默认 0（行为逐字节不变，shadow 态是稳态终点）。
- **⚠️ 隐藏前置（实核发现）**：`dist/server/handlers/chatHandler.js`（9/11 编译）**不含 `PROXY_ROUTE_OVERRIDE`**——override 代码（`chatHandler.ts:30/385`）从未编译进运行产物。
   `start.ts`（9/15）比 `dist`（9/11）新 4 天 → **翻 env 前必须先 `npm run build`**，否则翻了也是空操作。
- **注入方式（非侵入铁律，绝不全局 `launchctl setenv`）**：
   - cursor 无 `.env` 加载、无运行时 toggle → 只能靠**子进程 env + 重启**：`PROXY_ROUTE_OVERRIDE=1 node dist/server/start.js`；
   - 固化：`manage.sh start_cursor`(nohup 前)注入，或 `.env` + dotenv（需先加 dotenv，当前 `src/` 无 dotenv）。
   - **绝不** `launchctl setenv PROXY_ROUTE_OVERRIDE 1`（全局 env 注入，违反 ADR-0003 非侵入）。
- **验证（做，不擅自固化常驻）**：先 `npm run build` → 带 env 起 cursor → 发 **1 条 coding 请求**，看是否路由到 `deepseek-v4-pro` + HTTP 200（D7 已证此路 mock+live 通）；确认无误后老板定是否写进 `manage.sh` 常驻。
- **风险**：翻 1 后引擎建议**接管真实路由**（非只观测）；4 provider 全 enabled + `findProviderByType` 真名对齐 → 不再塌缩（旧 09-12 风险已消除，见 D5）。
- **回退**：停该进程即回 shadow 稳态（默认 0）。

---

## 三、价格基线初稿（我查的官方价 + 汇率估算，待老板拍板改代码）

> 注意：**不改 pricing 代码**——定价是商务决策，且 kimi 若在 DB disabled，校准是空改。本文档只给参考。

### 3.1 kimi-k2.6 官方价（Kimi 帮助中心,美元/1M tokens）
| 字段 | 价（美元/1M） | 换算人民币（假设汇率 7.2） |
|---|---|---|
| Input cache-miss | $0.95 | ≈ ¥6.84 |
| Input cache-hit | $0.16 | ≈ ¥1.15 |
| Output | $4.00 | ≈ ¥28.80 |

### 3.2 项目 pricing 表（`routeEngine.ts:198-202`，单位：人民币/1M tokens）
| 模型 | input | output | cacheHit | 备注 |
|---|---|---|---|---|
| qwen3.8:27b-mlx（ollama） | 0 | 0 | 0 | 本地免费 |
| agnes-2.5-flash | 0 | 0 | 0 | 免费（有配额） |
| deepseek-v4-pro | 1 | 4 | 0.02 | 缓存红利，性价比之王 |
| **kimi-k2.6** | **0.6（估算占位）** | **2.5（估算占位）** | **0.1（估算占位）** | **待校准** |

### 3.3 结论
- kimi-k2.6 真实价（output ~¥28.8 vs deepseek ~¥4 output、kimi 无 deepseek 级 cache 折扣）→ **kimi 在 cost-optimization 里几乎不会被选中**，只在 deepseek/agnes 都 down 时兜底。
- **建议校准**：`kimi-k2.6` pricing 估算占位 → 真实价（老板确认汇率 + 是否用 kimi 官方人民币价），消除 `routeEngine.ts:202` 的"估算占位"注释。
- **本轮不做**（不擅改：定价决策 + 若 kimi disabled 空改 + 上轮已归错两次需更稳）。

---

## 四、下一步（老板选）
1. **M6 真接管**（决策 2）：`cd cursor-proxy && npm run build`（dist 缺 override 代码）→ `PROXY_ROUTE_OVERRIDE=1 node dist/server/start.js` → 发 1 条 coding 请求验证路由到 deepseek-v4-pro（HTTP 200）→ 老板定是否写进 `manage.sh start_cursor` 常驻。
   - **决策 1（DB enable qwen3.8）已满足，无需动作**（4 provider 全 enabled）。
2. **校 kimi pricing**：确认汇率 + 人民币价 → 改 `routeEngine.ts:202` → 跑 cursor tsc+测试（119）确认不破。
3. **kimi 真连验证**（花点钱 + 用 key，老板决定何时跑）。
4. 都先不动，保持 shadow 稳态（也是合理终点）。
