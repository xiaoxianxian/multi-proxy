<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# free-llm · 填 key 三步走（每个用户装完照这个做）

**要不要充钱？不用。** 三家都是"注册即免费"，领个免费 key 填进去就行，没有付费/充值动作。

**还有一路「零账号」匿名池（Kilo）：装了就有，连 key 都不用填。** 它在 `providers.seed.json` 里是 `free-llm-kilo`（`api_key` 留空），`install.sh` 会自动并进去；风险是上游可能记录 prompt、限 ~200 次/小时/IP——敏感代码别走它。介意就别点安装，或多装那几家自带 key 的源。

## 一键向导（推荐）
```
node free-llm/key-wizard.mjs
```
向导会把三家 key 逐个问你（去哪个控制台领、链接都写在向导里）→ 自动写进 `free-llm/.env`（不进 git）→ 自动装进 18799 → 跑自检 → 打印各家状态。中途某家没领到，直接**回车跳过**，日后再跑一次补上即可。

也可非交互（全走环境变量）：
```
OPENROUTER_FREE_KEY=sk-or-... GROQ_FREE_KEY=gsk_... SILICONFLOW_FREE_KEY=sk-... node free-llm/key-wizard.mjs
```

## 各家领 key 链接
| 家 | 领 key 处 | 说明 |
|---|---|---|
| OpenRouter | https://openrouter.ai/keys | 注册 → Create Key，`:free` 模型 $0 |
| Groq | https://console.groq.com/keys | 注册 → Create API Key，免费速率限额；部分地区未开放 |
| 硅基流动 | https://cloud.siliconflow.cn | 注册领 key，本插件只用永久免费 7B 档 |

## 手动等价（不想跑向导）
1. 三家 key 都领到：`cp free-llm/.env.example free-llm/.env && $EDITOR free-llm/.env`（把 3 个 `__FILL_...__` 换成你的 key）
2. 重装：`bash free-llm/install.sh`（幂等：把 key 填进占位条目 + 刷新模型清单，绝不覆盖已填 key）
3. 自检：`node free-llm/test/test-e2e.mjs`（有 key 时各真跑一次 chat）

## 没填 key 会怎样？
不崩：18799 照常列出 6 个模型；没 key 的几家 chat 会 401 → 自动切换下一家；三家全没 key 就落到 Hermes 配置里的默认模型。

## 卸载
`bash free-llm/uninstall.sh`
