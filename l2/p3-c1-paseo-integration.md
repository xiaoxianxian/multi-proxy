# P3-c.1 评估：M7 session 对接 Paseo（非侵入方案，2026-09-14）

> 背景：方向六 P3-c.1 在 `MEMORY.md §13.6` 登记为挂起项（决策：先不动）。P3-b/c/d 已全部自研落地
> （tmux-keepalive 10/10 + session-keepalive 6/6 + 崩溃恢复 e2e 2/2，全绿自洽，零外部依赖）。
> 本文是 P3-c.1 的立项评估——把"Paseo 原生保活替代 P3-c 外层保活"这个选项落成可决策的非侵入方案，
> **不碰 P3-c 热路径**，等真有"手机/多端续看长任务"需求再实施。
>
> **决策：2026-09-20 老板定方案 A（维持现状）。** P3-c 自研 tmux 保活不动、零外部依赖；Paseo 仅作"可选多端监工层"、不接底层（B 外包 / C 全替代均不做、暂不排期）。零代码、零副作用。需求触发（手机续看 30min+ 长任务）再启 B，见 §三触发条件。

## 一、为什么要评估（现状核实，非凭印象）

2026-09-14 真查 Paseo 0.8.0 daemon（PID 86064 监听 `127.0.0.1:6767`，relay disabled 安全模式，`paseo ls` = `[]` 无 agent）：

| Paseo 命令 | 真实能力 | 对 M7 的对接意义 |
|---|---|---|
| `run <prompt> --provider <p/model> -d --title` | 起一个 Paseo 原生 agent 跑任务 | 把 M7 任务"外包"给 Paseo agent 跑 |
| `import <id> --provider <p> --cwd` | **导入一个 provider 原生 session/thread id** | ⚠️ 只吃 provider 体系内 session，**接不进来 M7 的体系外本地 session** |
| `attach <id>` / `logs <id>` / `wait <id>` | 看输出流 / 时间线 / 等 idle | 多端续看（手机/桌面/Web/CLI）——Paseo 唯一增量能力 |
| `hooks <agent> <event>` | 记 agent hook 事件 | 把 M7 step 当 hook 事件喂给 Paseo（观测，非保活） |
| `start --relay/--no-relay --web-ui --no-mcp` | 起 daemon（relay=手机续看的网络层） | 保活底层，但绑定 Paseo 自身 daemon 生命周期 |

**核心结论**：Paseo 的保活能力绑定在它**自己的 agent 生命周期**（`run`/`import`/`send`/`wait`）上，
没有"绑定任意本地 session 做 tmux 式保活"的通用 API。`import` 的入参是 *provider session/thread id*，
我们的 M7 session 是 `~/.multi-proxy-manager/sessions.json` 里的体系外本地记录，**`import` 直接接不进来**。
所以"Paseo 原生保活替代 P3-c 外层保活"不是简单换个底层，而是要 M7 把 session *注册成 Paseo agent*，
让 Paseo 拥有保活权——这是跨产品边界的架构决策，不是缺口的补全。

## 二、三个备选方案 + 权衡

| 方案 | 形态 | 好处 | 代价 | 评价 |
|---|---|---|---|---|
| **A 维持现状（推荐）** | P3-c 自研 tmux 保活不变；Paseo 仅可选做"多端监工层"（`attach/logs` 看 M7 任务输出） | 零耦合、测试全绿、不引入外部 daemon 依赖；P3-c 已自洽稳定 | 没有手机续看（Paseo 才能给的增量） | ✅ 缺口非阻塞，P3-c 已覆盖保活需求 |
| **B 外包式对接（次选）** | M7 任务用 `paseo run --provider` 起 Paseo agent 执行，`attach/logs` 续看，`sessions.json` 只记 `paseoAgentId` 做指针 | 多端续看 + Paseo 原生保活；观测面强 | 把任务执行权交给 Paseo agent（跨产品边界）；`import` 接不进本地 session，只能用 `run` 外包；测试面变外部依赖 | 有需求再做 |
| **C 全替代（不推荐）** | 用 Paseo daemon 替换 P3-c 的 tmux 保活底层 | 统一保活层 | 推翻已落地 6/6+2/2 全绿、引入外部 daemon 单点依赖、崩溃恢复 e2e 全要重做 | 性价比负 |

## 三、推荐：维持现状（方案 A）

P3-c 的 tmux-keepalive + checkpoint + 崩溃恢复已**完全自洽、零外部依赖**，覆盖了"保活"这个缺口。
Paseo 相对 P3-c 的**唯一增量能力是"手机/多端续看长任务"**——这是产品体验项，不是保活正确性项。

**决策**：维持 P3-c 自研保活作为主链路，Paseo 保持"可选监工层"地位，不接底层。
**触发条件**：当真出现"手机上续看一个跑了 30+ 分钟的 M7 长任务"这类需求时，再启动方案 B（外包式对接），
届时实施面 = M7 task 完成/进行中时可选 `paseo run -d` 起 agent + `sessions.json` 记 `paseoAgentId` 指针 +
`attach/logs` 续看，仍不推翻 P3-c 保活（两层并存，Paseo 管监工、P3-c 管保活）。

## 四、成本 / 风险

- **成本**：方案 B 实施面小（M7 task 起一个 `paseo run -d` + 记指针 + 续看命令），但**引入外部 daemon 依赖**
  （Paseo 0.8.0 需常驻），测试面从"纯本地"变"依赖 Paseo daemon 在线"。
- **风险**：① `import` 接不进本地 session（已核实），只能外包 `run`，外包即把执行权交外部 agent；
  ② Paseo relay 若开启是手机续看的网络面，安全模式下（relay disabled）无此能力，开 relay 需评估外网暴露；
  ③ 全替代（C）会把 P3-c 的崩溃恢复 e2e 全部失效，不可取。

## 五、实施前置（不阻塞）

- 触发：明确的"多端/手机续看"产品需求。
- 前置：P3-c 保活保持现状不回归（任何 Paseo 对接都不得让 P3-c 测试变红）。
- 验证：E2E 纪律不变——真 Paseo daemon + 真 M7 task 往返，`paseo run -d` 后 `attach/logs/wait` 证续看链路，
  `sessions.json` 的 `paseoAgentId` 指针可读回；不 mock 自说自话。

## 六、一句话总结

Paseo 对接是 P3-c 落地后回头的**纯优化增量**，非缺口；P3-c 自研保活已覆盖正确性需求，Paseo 的增量只在
"多端/手机续看"。推荐维持现状（A），需求触发再外包式对接（B），全替代（C）性价比负不做。本文只立评估、
不碰 P3-c 热路径，实施待需求。
