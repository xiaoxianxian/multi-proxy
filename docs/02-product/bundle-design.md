# DS2 前置设计:cordis.patch.yml / dsh.bundle 补丁结构（草案）

> 状态：DS1 已完成（.dsh/skills/ 骨架），DS2（npm bundle 发布）按 dsh-integration.md 暂缓（等 DSH 0.2 + #1496 guardrail 修复）。
> 本文件是"等待期提前设计"——把 `cordis.patch.yml` + `dsh.bundle` 的结构先想清楚，DSH 0.2 发布后可快速落地。
> **纯设计，非实施**：不发包、不打 tag、不写 `package.json#dsh.bundle`（仍属 DS2，保持暂缓）。
> 创建：2026-09-18。依据外部一手来源（见文末）。

## 1 官方规范（deepseek-harness bundle/cordis.patch.yml）

`cordis.patch.yml` 是一个 profile patch 层，规范要点（来源：deepseek-ai/deepseek-harness + dsh-plugin-model-proxy npm 包说明）：

- **结构**：顶层是 YAML 数组（patch entries）。`- insert:` 块下挂若干 plugin 行：
```yaml
- insert:
    - id: <loader-entry-id>
      name: <npm 包名 / Cordis 插件名>   # 注意是 name: 不是 module:
      config: { ... }                    # 插件配置
      disabled: false                    # 可选
```
- **`dsh.bundle.patch` 声明**：包的 `package.json` 声明 `dsh.bundle` → `dsh plugin add` 自动把包加进 profile 依赖 + 自动插入对应 insert 行到 `dsh.profile.bundles`，一次激活，无需手写 patch 行。
- **client 自动发现**：browser 端从包的 `dsh.client` 声明自动发现，serve 在 `/plugins/<name>/client.js`。

## 2 参照模板：dsh-plugin-model-proxy（与 multi-proxy L2 同构）

`dsh-plugin-model-proxy`：per `(provider, model)` 路由到不同 proxy（http/https/socks5/socks5h + Settings UI）。功能 = "特定 provider/model 走特定代理，其余直连 + 设置页卡片 + 可观测 status/test"。
这与 multi-proxy L2 路由（orchestrator + cost + alert + 门控）**高度同构**，是最佳设计模板。

其结构（来源：npm 包 dsh-plugin-model-proxy@0.1.2 说明）：
- 顶层 bundle 包，声明 `dsh.bundle.patch`
- host 半边：`installSettingsSection` 注册 `model-proxy` 设置命名空间（applies: live，改配置无需重启）
- host 半边：wrap `globalThis.fetch`（可逆，`ctx.effect` dispose 还原）
- 监听 `llm/stream` waterfall，按 `(provider, model)` 经 AsyncLocalStorage 解析 proxyUrl，注入 dispatcher
- browser 半边：注册 `settings.plugin.item`，由 Plugins tab 自动配对（served ∩ registered）

## 3 已知踩坑（来自社区插件实践，避免重蹈）

1. 文件必须是顶层 YAML 数组；纯注释（无 `- ` 行且无 `[]`）解析失败 → 破每次 boot/dump。
2. loader-entry 的字段是 **`name:`（包名），不是 `module:`**。
3. 新行必须嵌在 **`insert:`** 下；裸 `- id:` 表示"patch 已存在 entry"，不是新增。
4. 只 host 半边是 loader entry；browser 半边从 `dsh.client` 自动发现。**不要**手工加 `<name>/client` 行（会让浏览器代码在 Node 进程里跑）。
5. 有 `dsh.bundle.patch` 就别再手写 patch 行——`dsh plugin add` 已自动注入，重复 = boot 时同 loader id 冲突。
6. **client 端 `exports.inject` 写 Cordis 服务名（slots/settingsScope），不能写包名**——写包名会让插件永久 pending 卡死 web boot（LucienLL/dsh-plugin-proxy 的 LESSONS.md 记录）。
7. 设置页白名单限制：`WEB_SETTINGS_NAMESPACES`（dsh-host-apiproxy）硬编码，第三方命名空间需手动加（dsh 官方列为延后）→ multi-proxy 若暴露设置卡片需知此限制。
8. 测试需 `@deepseek-ai/*` peer 依赖 + undici（junction 到 DSH profile node_modules 或 pnpm install）。

## 4 multi-proxy 接入设计映射（草案，DSH 0.2 后落地）

- L2 内核（orchestrator / cost / alert / gate）→ 封装为 Cordis 插件
- `dsh.bundle.patch` 声明 `insert:` 行 id/name/config（参考 dsh-plugin-model-proxy 结构）
- 配置写入 `insert` 行的 `config:` 层（applies: live，对应门控 gate/cost/alarm）
- host 半边：注册设置命名空间 + wrap fetch（可逆）；browser 半边：设置卡片（注意白名单限制）

## 5 落地前置（外部依赖，项目无法控制）

- DSH 0.2 稳定（#1496 guardrail 修复：`dsh plugin add` 装错插件可能导致 profile 起不来且无回滚）
- 包规范确认（npm 包名 / 版本 / 构建产物）
- 满足后：本设计 → DS2 实施（`package.json#dsh.bundle` + `cordis.patch.yml` + 封装 L2 为 Cordis 插件 + 测试）

## 来源（外部，待 DSH 0.2 后按当时版本核对）

- 官方：deepseek-ai/deepseek-harness/packages/bundle/base/cordis.patch.yml + /web-app/cordis.patch.yml
- 参照：github.com/Ye-Yu-Mo/dsh-llm-proxy、npm dsh-plugin-model-proxy@0.1.2、github.com/LucienLL/dsh-plugin-proxy、github.com/superfish058/dsh-llm-proxy
- 抓取时间 2026-09-18，web 搜索快照（非官方文档正文，落地时核对）
