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
- 历史实测（2026-10-09 19:47）：`:8731` 未监听、无 h3web 进程。
- **2026-10-10 01:0x 实测：服务已起并跑通连通性** —— `GET / -> 200`、`/api/status/<fake> -> 404`（路由确实挂载）、`/api/characters -> 200`，且 `H3webAdapter.health() -> {"ok":true,"port":8731,"raw":200}`。自此「adapter 仅 mock 验证」这一过时表述作废。

**启动方式（标准库，无第三方依赖）：**
```bash
/usr/bin/python3 "/Users/xiaota/Documents/AI项目/本地部署Minimax H3/h3web.py"
```
> ⚠️ 两个坑（2026-10-10 实测）：
> 1. 用 `nohup ... &` 在受管 shell 里起，**进程会在命令结束后被清理**（日志无崩溃堆栈 = 外部信号杀掉）。要持久存活请用系统 launchd / 终端前台 / 服务托管方式。
> 2. `curl` 不加 `--noproxy '*'` 会拿到**代理返回的假 502**（`upstream connect failed`），别据此误判服务异常。

> 📌 常驻策略（维护者 2026-10-10 拍板）：**不给 h3web 配 launchd 常驻**。改由 multi-proxy 在使用侧「检测 → 提醒 → 可选一键开启」，见 §5。

### 2.2 用探测脚本验证（秒级、零副作用）
```bash
cd /Users/xiaota/Documents/AI项目/multi-proxy
node scripts/h3web-roundtrip-probe.js            # health 模式：探活 + 端点契约嗅探
# 期望：✓ h3web 在 :8731 探活成功；POST /api/gen -> {job_id,...}
```

### 2.3 真 round-trip（耗时长，显式开启）

**先弄清引擎路由再跑**（`h3web.py:49`）：`BRIDGE_BASE` 默认 `http://127.0.0.1:8799`，即**模块 B 常驻网关**，它不在 h3web 项目里，而是 `beeftv-bridge/h3_bridge.py`（维护者另一个自研件）。两条生成路径都**优先走 8799**，拿不到才回退 `own` 自起 h3 二进制 —— 回退 = 冷启动 50–60s + 加载百 GB 级权重。

- 起 8799：`python3 "/Users/xiaota/Documents/AI项目/本地部署Minimax H3/beeftv-bridge/h3_bridge.py"`（常驻，省重复冷加载，但**持续占内存**）
- 不起 8799：能跑通，代价是每次冷加载；验收阶段可接受，但必须先过 §2.5 资源门槛。

> 2026-10-10 决策：**本次未起 8799、未跑 `--gen`** —— 实测可用内存 ~5.9GB、swap 15.4/16GB 近打满、Ollama 在跑，不满足资源门槛。维护者验收完或停掉 Ollama 后再跑。

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
- [ ] **资源门槛（2026-10-10 实测，硬门槛）**：跑 `--gen` 会拉引擎加载百 GB 级权重。
      先查内存再决定，**swap 接近打满时禁止跑**：
      ```bash
      /usr/bin/python3 -c "
      import subprocess
      o=subprocess.run(['vm_stat'],capture_output=True,text=True).stdout
      d=dict((l.split(':',1)[0].strip(), l.split(':',1)[1].strip().rstrip('.')) for l in o.splitlines() if ':' in l)
      f=int(d.get('Pages free',0))+int(d.get('Pages speculative',0))+int(d.get('Pages inactive',0))
      print('可用约 %.1f GB'%(f*4096/1024**3))"
      sysctl vm.swapusage          # used 接近 total = 危险，先停 Ollama 再跑
      ```
      2026-10-10 01:0x 实测：可用 ~5.9GB、**swap 15.4/16GB 已近打满**、Ollama 11434 在跑 → 判定**不满足门槛**，`--gen` 未执行。
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

## 4 · multi-proxy 侧「检测 + 提醒 + 一键开启」（2026-10-10 新增）

> 维护者诉求原话：*"未来需要常驻的话，应该是 multi-proxy 检测到提醒我，或者检测到并且给我一键开启的功能。"*
> 落地形态：**不替 h3web 配 launchd**，改由 multi-proxy 在使用侧发现它没起就提醒 + 留显式授权的一键开启。

| 层 | 文件 | 职责 |
|----|------|------|
| 内核 | `multi-proxy-manager/lib/h3web-guard.js` | `probe()` 只读探活、`advice()` 生成提醒+启动建议、`start()` 门控拉起（detached 脱离 manager 生命周期）、`snapshot()` 聚合视图 |
| HTTP 面 | `multi-proxy-manager/routes/h3web-guard.js` | `GET /api/h3web/status`（只读，不鉴权，同 provider-health）、`POST /api/h3web/start`（`requireAuth` + 门控） |
| 挂载 | `multi-proxy-manager/server.js` | 挂在代理 wildcard 之前；启动期异步自检，down 就打印提醒与两条起法 |
| CLI | `scripts/h3web-roundtrip-probe.js --start` | 探测不到就拉起（`force:true` = CLI 显式授权，等价于门控开） |

**配置 env**：`PROXY_H3WEB_SCRIPT`（h3web.py 路径，默认已内置本机已知路径）、`PROXY_H3WEB_PORTS`（探测端口）、`PROXY_H3WEB_AUTOSTART=1`（放行 HTTP 一键开启，默认关）。

**不变式（与 provider-health / skill-hosts / mcp 同范式）**：
1. 探活**严格只读** —— 只发 `GET /`，绝不 `POST /api/gen`（那会触发引擎冷加载）。
2. 门控默认关 → `POST /api/h3web/start` 返回 403 并告知怎么开，**绝不擅自拉起外部进程**。
3. 服务 down 时 `GET /status` 仍返 `200` + `up:false`（"没起"是正常状态，不是 HTTP 错误）。

**实测证据（2026-10-10）**：
- up 分支：`{"up":true,"port":8731,"statusCode":200,"advice":{"level":"ok"}}`
- down 分支（探 19999）：`level:warn` + 完整 `command` / `api` / `gate` 建议
- 门控：`start()` 未开 env → `gated:true` 拒绝
- 一键开启真闭环：`--start` 用假脚本在 18799 spawn → 监听 → 探活 → `exit 0`（假服务已清理，未碰真 8731）

---

## 5 · 本文件结论
- h3web 接入：**已建 + 已测**，剩「起真服务 + 翻门控」两步，均有脚本/runbook 可复制。
- #7/#8/#D：**非代码缺口**，是 v2 范围或维护者决策，不擅自实现。
- 全部 shadow 能力（M6 / L2 executor / savings-gateway / h3web）均已建+已测+已接线，剩的是翻门控决策，均有 runbook。
