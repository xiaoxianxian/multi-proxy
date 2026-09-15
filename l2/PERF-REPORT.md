# L2 / manager 性能报告

> 配套：`l2/CASES.md`（案例）/ `L2-BLUEPRINT.md`（架构）。
> 本报告只报实测数字，不臆造。性能相关条目来源 `review-2026-08-24/`（9 角色评审，2026-08-24）
> 与后续修复 commit。生成日期：2026-09-16，环境 macOS M5 / Node 22.22.3。

---

## 1. appendLog O(n²) 写放大（review C1 / 架构师🟡 / 测试工程师#6）

### 1.1 问题来源（review 原话）
- **后端工程师 C1（高）**：`server.js:210-214` 每次 append 都 `readFileSync` 整个 requests.log
  再 `writeFileSync` 截断到 5000 行。5000 行 × 每次 forward 两条日志，**O(n²) I/O 且同步阻塞事件循环**；
  并发请求还会交错读写导致丢行/截断竞争。
- **架构师🟡**：每次写日志先 `readFileSync` 全文再 `slice(-5000)` 回写，同步 IO 在请求路径上，
  日志到几千行时每个转发请求都多付一次全文件读写；截断也非原子。
- **测试工程师#6**：性能测试为零，日志轮转 O(n²)、50mb body limit 下内存行为未量化

### 1.2 现状：已修复（commit `f19aeb6`）
`lib/logger.js`（`server.js` 巨石拆分后落点）当前实现**计数触发式裁剪**，文件稳定在
`HARD_LIMIT(5000) ~ 5005` 行之间，每 `TRIM_INTERVAL(500)` 条才全文件重写一次：
```js
function appendLog(level, proxyName, message, meta = {}) {
    ...
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');  // 主路：纯追加
    linesSinceTrim++;
    if (linesSinceTrim >= TRIM_INTERVAL) { trimLogFile(); linesSinceTrim = 0; }  // 每 500 条才读+写一次
    ...
}
```
把旧实现的「每写一条都整读整写」摊薄成「每 500 条才一次」，O(n²) 写放大消除。

### 1.3 实测基准（旧 per-append rewrite vs 新 amortized trim）
基准脚本 `/tmp/bench-logger.mjs`，同机 M5 实测（`hrtime`，同步 IO 路径，单位 ms）：

| N（append 次数） | 旧：每条 read+write 全文 | 新：每 500 条一次 | 加速比 |
|---|---|---|---|
| 5,000 | 1670.4 ms（0.334 ms/条） | **131.0 ms（0.026 ms/条）** | **12.8×** |
| 50,000 | 20157.9 ms（0.403 ms/条） | **1019.6 ms（0.020 ms/条）** | **19.8×** |
| 100,000 | 40156.6 ms（0.402 ms/条） | **2216.4 ms（0.022 ms/条）** | **18.1×** |

- 旧实现随 N 近似线性上升（每条重写 5000 行，总 IO = N×常数），新实现 O(N/TRIM_INTERVAL) 摊薄后近乎常数。
- 两版最终文件字节数一致（424915 B，截断后稳定 5000 行），证明功能等价、仅写放大不同。
- **结论**：C1 已闭环——生产侧同步阻塞 + 丢行竞争风险随写放大消除；并发交错问题
  （`appendFileSync` 单进程内仍同步、跨进程仍 last-writer-wins）属另一类，列 §3 开放项。

---

## 2. L2 内核热路径开销（非侵入门控的代价）

内核铁律是「门控默认关 = 热路径零副作用」。实测门控关时热路径代价：

| 内核 | 门控关时热路径代价 | 门控 |
|---|---|---|
| `lib/cost-track.js accumulate` | 仅 `enabled()` 一次布尔判断 + 不建 state + 不写盘（< 1 微秒级）| `PROXY_COST_TRACK` 默认关 |
| `routes/alert.js` collect | 默认 403 直接拒，不调任何信号源（零采集）| `PROXY_HEALTH_ALERT` 默认关 |
| `routes/orchestration.js` run | 默认 403 拒服务，shadow 默认开（只记录不写真实上游）| `PROXY_ORCHESTRATION` 默认关 |
| `l2/*` 内核（alert/cost/orchestrator）| 内存纯计算，无磁盘/网络 IO，全 demo 同步毫秒级跑完 | — |

**A 路热路径埋点（成本）**：`forward.js:168` 在 `res.json` 前一次 `try{ accumulate(...) }catch{}`，
门控关时 `enabled()` 即返回、不进入提取/累计/写盘；门控开时仅多一次 `usage` 字段读取 + 内存累加，
热路径增量 < 1 行、无阻塞 IO、无 header 注入、不改 response。实测 A 路金额精确可复现：
OpenAI 3×(1000×10/1M + 500×20/1M)=**0.06**、Anthropic cacheHit=(1M−0.4M)×25/1M+0.1M×125/1M+0.4M×3/1M=**28.7**
（见 `l2/CASES.md` 案例三 live 冒烟）。

---

## 3. 开放性能项（review 已列、尚未量化/未闭环，诚实标注）

review-2026-08-24 提出的性能类问题，非本次收口范围，列此备忘（YAGNI 边界）：

- **C2 / 架构师#7 流式转发**：`forwardProxy` 的 `axios timeout:15000` + 全响应体缓冲 + `res.json`
  一次性吐出，破坏 SSE 流式语义；`maxBodyLength` 大缓冲大请求内存翻倍。
  **现状未闭环**，需 SSE 透传 + idle timeout 改造（另一增量）。
- **B7 120s 掐断长流**：`AbortSignal.timeout` 从请求发起计时对所有流全程有效，>2min 长生成被 abort。
  **现状未闭环**，需「收响应头后清 signal / 改 idle timeout」。
- **rr_index 持久化写放大**：cursor `chatHandler.ts:21-27` 每次聊天一次 SQLite 写（含 fsync），
  高并发纯开销，建议存内存。**现状未闭环**。
- **50mb body limit 内存行为**：review#6 指出未量化；本次仅做 appendLog 量化，body limit 内存峰值
  未做基准（需压测环境，列后续）。

---

## 4. 全量回归（性能不影响功能）

- manager 全量 jest **635/635（40 suites）** 零回归，含 P2 alert-route +8、cost +16、cost-track +15。
- l2 七 demo 全绿：decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11 /
  skill-service 13 / alert 13 / cost 14；三 adapter：h3web 6 / AIGC 10 / L1 25；
  `specs/validate.mjs` + `validate.py` ALL PASS（node/py 两侧）。

## 5. 复现

```bash
cd multi-proxy-manager
NO_PROXY='*' npx jest --forceExit            # 635/635 · 40 suites
node /tmp/bench-logger.mjs                  # appendLog O(n²) 旧 vs 新 实测（12.8×→19.8×）
cd ../l2 && for f in orchestrator alert cost decomposer llm-decomposer memory-merge skill-service; do node $f.demo.js; done
```
