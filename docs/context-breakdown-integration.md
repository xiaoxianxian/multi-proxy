# context-breakdown 集成 runbook（shell 恢复后执行）

> 2026-10-15。背景：本会话 shell 执行层被沙箱故障搞死（所有 bash SIGKILL，含提权与子代理），
> **已落地**（新文件，零回归风险）：口径文档、`l2/context-events.js`、`l2/context-report.js`、
> `multi-proxy-manager/lib/context-store.js`、`routes/context.js`、`public/context.html`、
> `tests/unit/context-events.test.js`、`tests/unit/context-store.test.js`。
> **未落地**（要改运行中服务的文件，必须跑测后上）：下面三处补丁 + 测试 + e2e。
> 纪律：改完必跑机器复验；不 commit（WIP 归老板）。

## 补丁 1 · server.js 挂载（3 行）

在 `multi-proxy-manager/server.js` 中，`app.use('/api/cost', require('./routes/cost-report'));`（第 112 行）**之后**插入：

```js
// context-breakdown：lane 上报 + 面板查询（门控 PROXY_CONTEXT_TRACK 默认关；口径 docs/context-breakdown-口径.md）
app.use('/api/context', require('./routes/context'));
```

同文件 SPA routeMap（第 146-156 行）内，`'/floor': 'floor.html',` 之后加一行：

```js
      '/context': 'context.html',
```

## 补丁 2 · lane 钩子（dsh-proxy + generic-openai-proxy 两个文件）

锚点：各文件里每个 `reportUsage(...)` 调用点之后（grep `reportUsage(` 找，chat/completions 与 messages 两条线各一处）。
插入（变量名按各文件实际微调，`detectAgent(req)` 两个 lane 都有；generic 没有就写 `'generic'`）：

```js
    // ── context-breakdown 观测（门控 PROXY_CONTEXT_TRACK 默认关 = 零开销；口径 docs/context-breakdown-口径.md）──
    // 旁路铁律同 reportUsage：全 catch、不拖主路径。只报计数，不报正文。
    try {
      require('../../l2/context-report').observe({
        agent: 'dsh-proxy',            // generic lane 改成 'generic-openai-proxy'
        reqId: null,                   // v1 不做幂等（store 无去重）；要接就传请求级 id
        model: <上游实际 model>,        // 同 reportUsage 第 4 参的来源
        requestModel: req.body && req.body.model,
        clientKey: detectAgent(req),   // 帧归属键（口径 §3）；generic 无 detectAgent 时用 'generic'
        request: req.body,
        actuals: <上游 usage 对象或 null>, // 非流式 response.data.usage；流式先不接（usage 在流末）
      });
    } catch { /* 观测失败不是转发失败 */ }
```

⚠️ 流式线（SSE）先不接：usage 藏在流末，v1 只接非流式完成点（与 cost-track 流式分支「暂不接」同决定）。
⚠️ 每处调用点的 `<上游实际 model>` / `<上游 usage>` 按该处已有变量填（reportUsage 第 4 参就是 model 的来源）。

## 补丁 3 · dashboard 侧边栏入口（可选）

`public/dashboard.html` 的侧边栏导航里，仿 floor 入口加一条指向 `context.html` 的链接
（该文件是 SPA，侧边栏由 JS 渲染，grep `floor.html` 找同款节点照抄）。
context.html 自带独立侧边栏，不做这步也能直接开 `http://127.0.0.1:18792/context`。

## 验证（按序跑，全绿才算完）

```bash
cd /Users/xiaota/Documents/AI项目/multi-proxy/multi-proxy-manager

# 1. 单元测试（新文件 + 防回归：context-fold 内核不许被带坏）
npx jest tests/unit/context-events.test.js tests/unit/context-store.test.js tests/unit/context-fold.test.js tests/unit/cost-track.test.js

# 2. manager 起停自检（补丁 1 后）
node -e "require('./server.js'); console.log('server.js loads OK')"

# 3. e2e（私有实例，不碰老板跑着的 lane；上游用本地 ollama，不花云额度）
#    3a. 起一个只给自己用的 generic lane 实例：
cd /Users/xiaota/Documents/AI项目/multi-proxy/generic-openai-proxy
PROXY_CONTEXT_TRACK=1 MANAGER_AGENT_TOKEN=$(cat ~/.multi-proxy-manager/agent-token) \
  PORT=18799 node proxy.js &   # 18799 已被占用就换 18901
#    3b. 三发上下文递增的请求（system+tools+messages 都要有，才能看七类）：
curl -s http://127.0.0.1:18799/v1/chat/completions -H 'content-type: application/json' -H "x-agent: e2e" -d '{
  "model":"qwen3:4b","messages":[
    {"role":"system","content":"你是测试助手"},
    {"role":"user","content":"第一轮：用一句话介绍你自己"}],"tools":[{"type":"function","function":{"name":"get_time","parameters":{"type":"object","properties":{}}}}]}'
#    （再发两轮，messages 逐轮变长；第三轮后 total 应明显高于第一轮）
#    3c. 查聚合与落盘：
curl -s "http://127.0.0.1:18792/api/context/summary?windowMs=600000" | python3 -m json.tool
curl -s "http://127.0.0.1:18792/api/context/recent?n=5" | python3 -m json.tool
wc -l ~/.multi-proxy-manager/context-ledger.jsonl
#    3d. 面板：浏览器开 http://127.0.0.1:18792/context —— KPI/七类条/趋势/事件四区有数
#    3e. 杀掉 3a 的私有实例（kill %1 或按 PID），老板的 lane 全程没被碰
```

## 通过标准（缺一不可）

- [ ] 4 个测试文件全绿（含 context-fold 防回归）
- [ ] `server.js loads OK`（补丁 1 无语法/装配错误）
- [ ] summary 里 `requests >= 3`、`byCategory` 七类有值、`peak > 第一轮 total`
- [ ] recent 的行**只有计数没有正文**（隐私纪律，grep `content|messages|prompt` 应为空）
- [ ] 面板四区渲染，门控 chip 显示「观测中」
- [ ] 私有实例已杀；`git status` 只有本次新增/修改的文件，未 commit

## 回滚

新文件直接删（无任何被 require 的入口，除了已打的补丁——补丁删掉即可）。
ledger 文件在 `~/.multi-proxy-manager/context-ledger.jsonl`，删不删都不影响功能。

## 已验证（2026-10-16，shell 恢复后跑完）

> 环境纪律：本会话初因沙箱故障断，恢复后继续。验证全程不动老板跑着的 18792 manager / 任何 lane；
> e2e 用独立临时 manager 实例（:18793）+ 真 `context-report.observe` + 真路由/鉴权/存储/聚合回读。

- [x] 4 个单测全绿（context-events / context-store / context-fold 防回归 / cost-track）：**85 passed, 0 failed**。
- [x] 语法体检：`server.js` / `routes/context.js` / `generic-openai-proxy/proxy.js` / `dsh-proxy/proxy.js` 全部 `node --check` 通过。
- [x] lane 的 `require('../l2/context-report')` 路径从 `generic-openai-proxy/` 正确解析（默认 `enabled()=false`，符合门控默认关）。
- [x] **e2e 数据管线 PASS**：3 笔递增请求 → summary.requests=3、七类组成全部有值、peak(338) > 首帧(88)、recent 无正文泄漏（隐私纪律成立）、推断事件在场。
- [x] ledger 清理干净（e2e 测试行已按 clientKey=e2e 过滤移除）。

### ⚠️ 验证中抓到的回归（已当场修）

`l2/context-report.js` 原导出写成 `observe: _singleton.observe`（裸方法引用）。
lane 侧 `require('../l2/context-report').observe(...)` 调时 `this` 指向 exports 而非 `_singleton`
→ `this._lastFrame` / `this.fold` 为 undefined → `observe` 抛错被吞、静默返回 null（等价于「观测失效且不报错」）。
**已改为 `observe: _singleton.observe.bind(_singleton)`（reset 同步 bind）。** 这正是「我改了≠改对了」要抓的那类坑——
没跑 e2e 永远发现不了（单测只测了内核，没测单例导出绑定）。

### 上线前老板要做的（不在本任务自动执行）

1. 让跑着的 18792 manager 重新加载新路由：重启 manager（或热重载），否则 `/api/context/*` 还是 404。
2. 开门控：给 manager 与要观测的 lane 都设 `PROXY_CONTEXT_TRACK=1`（默认关 = 零开销；不开不采数）。
3. 面板直达：`http://127.0.0.1:18792/context`（routeMap 已加，无需改 dashboard 侧栏，context.html 自带侧栏）。
4. 当前只接了 **非流式 `chat/completions` 完成点**（dsh-proxy:1108 / generic:1115）；流式与 `/v1/messages` 按口径 §6 暂不接（usage 藏于流末）。
