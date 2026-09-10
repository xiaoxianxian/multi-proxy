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
  - 本地模型用 `type: "local"` + `baseUrl`，单价全 0。

## ⚠️ 安全
- **真实 `providers.json` 含 api_key，已被 `.gitignore` 保护，切勿提交。**
- 本模板的 `api_key` 均为占位符，可安全入库。
