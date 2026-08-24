# 可插拔架构改造评估报告（2026-08-25）

> 对应 HANDOVER-2026-08-24.md 第五节待办 #2。
> 结论先行：**分阶段做，先做服务端注册表（低风险高收益），shell 脚本次之，前端最后且可不做。**

## 一、现状：新增一个代理（如 Pi/Qoder）要改几处？

实测统计（grep 硬编码次数）：

| 文件 | codex | hermes | cursor | 新增代理需改动的注册点 |
|------|------:|-------:|-------:|------|
| `multi-proxy-manager/server.js` | 13 | 11 | 11 | **4 处**：`buildProxyConfigs()`(~15行)、`FORWARD_ENDPOINTS`(~5行)、`DOCKER_SERVICE_NAMES`、`DOCKER_CONTAINER_NAMES` |
| `manage.sh` | 22 | 22 | 25 | **~40 行**：`start_X()`、stop/restart 委托、顶层 case 分支、show_status/show_logs |
| `install.sh` | 15 | 13 | 18 | **~35 行**：`install_X()`、`uninstall_X()`、交互菜单、`--all` |
| `public/proxy-config.html` | 8 | 9 | 27 | 页内 JS 的 proxy 列表、端点分流（switchModel 按 proxy 分流等） |
| `public/dashboard.html` | - | - | - | 展示列表若已数据驱动则零改动（待验证） |
| `tools/agent-proxy-switch` | 22 | 23 | 12 | 可选，新 agent 才需要 |

合计：**新增一个代理 ≈ 90–120 行分散在 4+ 个文件的样板代码**，其中 server.js 两处
（PROXY_CONFIGS / FORWARD_ENDPOINTS）漏掉任何一处都会出现「进程管理正常但 API 转发
401/404」或反向的静默错位。

## 二、方案对比

### 方案 A：per-proxy 配置文件（推荐目标态）
```
proxies/
  codex.json    { port, name, startCommand, startArgs, cwd, checkFile,
                  dockerService, dockerContainer,
                  forwardEndpoints: { GET:[], POST:[], PUT:[], DELETE:[] } }
  hermes.json
  cursor.json
```
- server.js 启动时扫目录合并 → `buildProxyConfigs`/`FORWARD_ENDPOINTS`/两个 DOCKER 表
  四处收敛为一处加载逻辑；新增代理 = 放一个 json 文件。
- install.sh/manage.sh 读同一份 json（bash 用 python3 -c 或 jq 解析），start/install
  函数参数化。
- **优点**：单一事实来源，server 与 shell 不再各自漂移（评审 P2 已指出三实现漂移约 70%）。
- **缺点**：bash 解析 JSON 是弱项，需要引入 jq 依赖或 python3 桥接。

### 方案 B：单一 proxies.json 注册表
同 A 但只有一个文件。更简单，但多代理并发改配置时 diff 冲突集中——个人项目无所谓，
**对单人仓库反而比 A 更简洁**。

### 方案 C：只做 server.js 内部收敛（最小改动）
不动文件格式，把四个硬编码点合并成 `proxies/registry.js` 一个 JS 模块导出全部配置。
- **优点**：纯 Node 改动，无 bash/JSON 工具链问题，测试好写；半天工作量。
- **缺点**：shell 脚本仍各写一份（但 shell 本来就无法 require JS，除非走 python3 桥）。

## 三、建议：两步走

| 阶段 | 内容 | 风险 | 收益 | 预估 |
|------|------|------|------|------|
| 第 1 步 | 方案 C：server.js 抽 `proxies/registry.js`，四处引用改为读模块；补单测验证「注册表驱动 buildProxyConfigs/FORWARD_ENDPOINTS」 | 低（纯重构，379 个 Manager 测试护航） | server 侧新增代理从 4 处 → 1 处 | 半天 |
| 第 2 步 | registry 导出 JSON schema，manage.sh/install.sh 参数化读取（python3 已是 hermes 依赖，可直接用） | 中（shell 改坏影响启停） | 全链路新增代理 ≈ 写一个 json + 少量特例 | 一天 |

**不建议做的部分**：
- 前端四页面泛化——proxy-config.html 里 27 处 cursor 引用大多是**业务逻辑差异**
 （switch-model 端点不同、admin-api 前缀不同），不是简单列表，抽配置收益低、回归面大。
 新增代理时在页内加一个分支即可，与现状一致。
- tools/agent-proxy-switch 泛化——每个 agent 的配置文件格式完全不同
 （toml/yaml/GUI），抽象不出公共结构，保持每 agent 显式分支是对的。

## 四、前置依赖提醒

第 2 步动 manage.sh 前，建议先修评审 P0-7（LaunchAgent KeepAlive=true 无限重启风暴），
否则 shell 重构期间的失误会被 KeepAlive 放大成重启循环。

## 五、验收标准（供后续实施时使用）

1. `node multi-proxy-manager/server.js` 正常启动，/api/status 返回三个代理；
2. 新增一个 fake-proxy json（端口 18999）后无需改任何 .js/.sh，status 能列出它；
3. Manager 379 测试全绿；codex/hermes stop/start 实测正常。
