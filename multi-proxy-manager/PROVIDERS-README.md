# providers.sample.json — 配置模板 / 加载说明

本文件是 `proxy-rebuild` 的 **provider 配置模板**，供后续实现方向四
（按任务类型智能派发路由 / cost-optimization，见 `ITERATION-ROADMAP.md`）时直接照抄。
它**不会被程序自动加载**，请勿当作运行配置使用。

## 真值文件在哪（运行时）
manager 读取的真实配置位于用户目录（**不在仓库内**）：

```
~/.multi-proxy-manager/providers.json
```

路径由 `os.homedir()` 决定；manager 的密码、崩溃恢复等也都存在这个目录。

## 加载 / 使用方式（三选一）
1. **手动落地（迭代期推荐）**：复制模板并填真值 key
   ```bash
   cp multi-proxy-manager/providers.sample.json ~/.multi-proxy-manager/providers.json
   # 编辑 ~/.multi-proxy-manager/providers.json，把 sk-YOUR-*-KEY 换成真实 key
   ```
2. **通过 manager UI / API 添加**：在供应商管理界面逐个添加，`base_url` / `api_key` /
   `models` 字段与本模板一致。
3. **方向四实现后**：路由引擎会读取每个 model 的 `pricing` / `rateLimit` / `baseUrl`
   做 cost-optimization 与免费配额门控（**当前代码尚未使用这些字段，属前向兼容预留**）。

## 字段说明
- 顶层保持与现有 manager schema 兼容：
  `id / name / provider_id / base_url / api_key / enabled / created_at / updated_at`，可选 `models`。
- 方向四新增（前向兼容预留）：
  - `pricing`: `{ input, output, cacheHit }` —— 每百万 tokens 的人民币单价，cost-optimization 查此表。
  - `rateLimit`: `{ per5h, perWeek }` —— 免费档（如 Agnes）的配额；`null` 表示不限。
  - `rateLimitKind` / `rateLimitObserved`（2026-10-02 新增，实测字段）：`rateLimit` 只描述**总量**口径，
    2026-10-02 实测发现 agnes 免费档撞的是**短时窗口的请求次数**，跟总量不是一回事，所以另开两个字段把实测结论钉在这里。
    详见文末《Agnes 免费档限流口径（2026-10-02 实测）》。
  - 本地模型用 `type: "local"` + `baseUrl`，单价全 0。

## Agnes 免费档限流口径（2026-10-02 实测）
维护者口述「免费 + 只有并发量限制」——**并发那半句已被实测推翻**。

| 实验 | 结果 | 说明什么 |
|---|---|---|
| 慢速串行 每 3s ×20 次（并发≈1） | **4 次 429** | 并发≈1 也撞墙 ⇒ 限制对象是**速率窗口内的请求次数**，不是并发数 |
| 瞬时并发 8 路 | 8×200 | 低并发无脑过 |
| 瞬时并发 24 路 | 13×200 / 11×429 | |
| 瞬时并发 30 路 | 15×200 / 15×429 | |
| 瞬时并发 48 路 | 全 429 | |
| 429 后冷却观察 | +1s 429、+22s 429、**+45s 200** | 恢复窗口约 30~45s |
| 429 body | `{"error":{"type":"AgnesAI_error","message":"You've reached the API rate limit for free users...","code":""}}` | **无 concurrency 字段** |

- 结论：免费档是**短时窗口的请求次数**限制（rate-window-request-count），并发只是让它更快撞上。
- `rateLimit.per5h/perWeek` 是**总量**口径，与实测的短时窗口不是一回事，别混用、别拿实测数字当配额上限。
- ⚠️ **confounder**：本机 WorkBuddy/codex 可能与同一个 key 共享额度 ⇒ 绝对阈值未标定，本表只用于定性判别，不用于算配额。
- 探针脚本：`/tmp/agnes429/discrimin.mjs`（判别）、`/tmp/agnes429/evid.mjs`（并发阶梯）。

## ⚠️ 安全
- **真实 `providers.json` 含 api_key，已被 `.gitignore` 保护，切勿提交。**
- 本模板的 `api_key` 均为占位符，可安全入库。
