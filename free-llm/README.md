# free-llm · 免费模型聚合插件（multi-proxy 可选插件）

> 一句话：**把 OpenRouter / Groq / 硅基流动 三家的「免费 key」灌进 multi-proxy 的
> `providers.json`，一个门口给你一堆免费模型；某家 429 就自动切下一家。**
>
> 这是一个**可选插件**：要就 `install`，不要就 `uninstall`，删了它 multi-proxy 主体完全不受影响。
> 所以「免费源会不会挂、有没有 SLA」是**本插件声明过的已知限制**，不是 multi-proxy 对用户的承诺。

---

## 1. 大白话：它到底是什么

multi-proxy 主体（`generic-openai-proxy`，端口 **18799**）本来就是一块「接线板」：
你能往 `providers.json` 里塞任意 OpenAI 兼容的 `base_url + api_key`，它就给你转成
一个统一门口。本插件干的是把**三块「免费积木」**摆上去：

```
你 (hermes/dsh)                18799 接线板                  上游
      │  我要模型 X   ───────▶  OpenRouter ──▶  免费模型 X:free
      │                        Groq       ──▶  免费模型
      │                        硅基流动   ──▶  免费模型
      │  ◀────── 某家 429 / 断流，接线板自动切下一家
```

- **免费不是 multi-proxy 送的**，是三家自己送的免费额度。multi-proxy 只做两件：
  ① 把几家接成一个口；② 一家 429/断流就沿 `fallback` 链切下一家（`generic-openai-proxy/failover.js`，有界 5 跳 + 去重防死循环）。
- **加 key 不用重启 18799**：它每请求重读 `providers.json`（`proxy.js:469 loadProviders()`）。

## 2. 风险（必须知道，别当无限白嫖）

| 风险 | 说明 | 应对 |
|---|---|---|
| 免费额度随时变 | 免费=各家拉新/促销，涨价、收紧、取消都不打招呼 | 无 SLA；挂了重新调，别把生产押它上 |
| 各家目录不重叠 | 切下一家可能是「另一款模型」，不是同一款 | `fallback` 跨三家轮换（免费目录本就不重叠），切到的是另一家的另一款模型，语义变化属预期 |
| ToS / 合规 | 多数免费 key 只许**个人自用**，禁转售/禁公开服务 | 仅限自用；对外提供前逐家看 ToS |
| key 集中 | 三家 key 都在 live `providers.json` | 该文件 0600 + 已 `.gitignore`（含 `providers.json`/`.env`/`.multi-proxy-manager/`），不进 git |
| 地区门 | 个别免费源对部分地区不开 | 以你本机（东京）实测为准 |

## 3. 免责条款（本插件核心立场）

1. 本插件**不保证**任何免费模型的可用性、额度、速度。免费源可随时失效。
2. 填入的是**用户自己的**各家免费 key；因用户误用/商用/超 ToS 产生的封禁/计费，由用户负责。
3. multi-proxy 主体只负责「聚合 + 429 切换」这个通用能力，**不对免费源的存续担责**。
4. 卸载 `uninstall` 只移除本插件加的 `free-llm-*` 条目，**不动**用户其它 provider、不重启、不删数据。

## 4. 用法

**推荐：一键向导**（领 key + 写 .env + 装进 18799 + 自检 + 状态报告，一条龙）：
```bash
node free-llm/key-wizard.mjs
```
向导逐个问你各家去哪领 key（链接都在里面），自动写 `free-llm/.env`（不进 git）、装进 18799、跑自检、打印各家状态；没领到的直接回车跳过。三家都是**注册即免费、不充钱**。

手动等价（不想跑向导）：
```bash
# 1) 领三家免费 key，写进 free-llm/.env（已被 gitignore）
cp free-llm/.env.example free-llm/.env && $EDITOR free-llm/.env
# 2) 安装（备份 live → 合并 3 家 → 确保 18799 在跑；幂等：把 key 填进占位条目 + 刷新模型清单）
bash free-llm/install.sh
# 3) 自检（健康 + /v1/models 列出 free 模型 + 有 key 就真跑一次 chat）
node free-llm/test/test-e2e.mjs
# 4) 要关了就一键卸载
bash free-llm/uninstall.sh
```

**不写 key 也能装**：占位 key 会装进去，`/v1/models` 能列出这些模型名（数据层面），但真正 chat 会因 401 失败——填好 key 后重跑 `install.sh` 或 `key-wizard.mjs`（幂等，已有真 key 不覆盖）。

操作卡（每个用户照做）：`free-llm/KEY-SETUP.md`。

**OpenRouter 免费档会轮换**（2026-10-19 核到 16 家 `:free`，主力是 nemotron/inkling/gemma 这批，
deepseek-r1:free 等早已下牌）。重装 / 补全 key 前，可免鉴权重拉一次公开 `/v1/models` 刷新 seed
的 `:free` 清单；Groq / 硅基流动 的免费目录要 key 后以其 `/v1/models` 为准。

## 5. 目录

```
free-llm/
├── README.md            本文件（原理 + 风险 + 免责）
├── KEY-SETUP.md         填 key 操作卡（每个用户装完照做：领 key 链接 + 一键向导）
├── manifest.json        机器可读：端点 / is_free 列表 / key_mode / 免责 / 版本
├── providers.seed.json  3 家免费 provider 模板（key 占位 + 跨家 fallback 链 + is_free）
├── key-wizard.mjs       一键 key 录入向导（写 .env→装 18799→自检→状态报告）
├── install.sh           备份→合并进 live providers.json→确保 18799 在跑（幂等：填 key+刷新清单）
├── uninstall.sh         按 free-llm-* 前缀移除→回滚备份（不动其它 provider）
├── .env.example         三家 key 模板（.env 已被 gitignore，真实 key 不进 git）
└── test/test-e2e.mjs    健康 + /v1/models + （有 key 才）chat 自检
```

> `is_free` 标签：本插件的 `manifest.json` 携带 `is_free` 模型清单（对齐 opencode-free 的
> manifest 约定）。`generic-openai-proxy` 的 `/v1/models` 按设计只吐 `{id, object, created, owned_by}`
> 四个字段，**不额外改核心代码**（守 multi-proxy AGENTS 铁律 #4）；读 manifest 的客户端可据此识别免费模型。
