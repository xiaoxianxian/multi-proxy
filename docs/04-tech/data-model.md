# docs/04-tech/data-model.md — 数据模型

> 基于 `cursor-proxy/data/proxy.db` 真实 schema 扫出。
> 最后验证：2026-09-17，HEAD `d9219af`，main。

---

## 数据库文件

| 项目 | 值 |
|------|---|
| 引擎 | SQLite 3 |
| 路径 | `cursor-proxy/data/proxy.db` |
| 大小 | ~50KB（测试数据） |
| 模式 | WAL 模式 |

---

## Schema

### providers（供应商）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| name | TEXT | NOT NULL | 显示名（如"OpenAI"） |
| provider_id | TEXT | NOT NULL UNIQUE | 类型标识（openai/anthropic/google/ollama/deepseek/azure/openai-compatible） |
| api_key | TEXT | NOT NULL | Base64 编码 |
| base_url | TEXT | NOT NULL | API 基础地址（不含 /v1） |
| enabled | INTEGER | DEFAULT 1 | 是否启用（0/1） |
| created_at | TEXT | DEFAULT datetime('now') | 创建时间 |
| updated_at | TEXT | DEFAULT datetime('now') | 更新时间 |

**索引**：`unique_provider_id ON providers(provider_id)`

### models（模型）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| provider_id | TEXT | NOT NULL FK→providers.id | 所属供应商 |
| name | TEXT | NOT NULL | 模型名（如"gpt-4o"） |
| enabled | INTEGER | DEFAULT 1 | 是否启用 |
| alias | TEXT | NULL | 别名（用于 API 兼容） |
| created_at | TEXT | DEFAULT datetime('now') | 创建时间 |

**索引**：`idx_models_name ON models(name)`

### routes（路由规则）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| default_model | TEXT | NOT NULL | 默认模型 ID |
| fallback_chain | TEXT | NOT NULL | JSON 数组，备选模型列表 |
| rules | TEXT | DEFAULT '[]' | JSON 数组，匹配规则（priority/order） |
| max_retries | INTEGER | DEFAULT 2 | 最大重试次数 |
| created_at | TEXT | DEFAULT datetime('now') | 创建时间 |

### settings（全局配置）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| key | TEXT | PRIMARY KEY | 配置键（如 `JWt_SECRET`, `MANAGER_PORT`） |
| value | TEXT | NOT NULL | 配置值 |
| value_type | TEXT | DEFAULT 'string' | 类型（string/number/boolean/json） |

### logs（操作日志）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| timestamp | TEXT | DEFAULT datetime('now') | 日志时间 |
| level | TEXT | NOT NULL | 级别（info/warn/error） |
| message | TEXT | NOT NULL | 日志内容 |

**索引**：`idx_logs_timestamp ON logs(timestamp)`

---

## 关系图

```
providers ──1:N──→ models
                 ──1:N──→ routes（default_model 引用 models.id）
settings  ── 独立表 ── 无外键
logs      ── 独立表 ── 无外键
```

---

## 访问方式

```bash
# 查看 schema
sqlite3 cursor-proxy/data/proxy.db ".schema"

# 查看供应商
sqlite3 cursor-proxy/data/proxy.db "SELECT id, name, provider_id, enabled FROM providers;"

# 查看模型
sqlite3 cursor-proxy/data/proxy.db "SELECT m.id, m.name, p.name as provider FROM models m JOIN providers p ON m.provider_id=p.id;"

# 查看所有设置
sqlite3 cursor-proxy/data/proxy.db "SELECT * FROM settings ORDER BY key;"
```

---

## 注意

1. **api_key 编码**：存库前 Base64 编码，API 返回脱敏（只显示前 4 位 + ****）
2. **provider_id 唯一**：每个类型只能有一个供应商记录（provider_id UNIQUE）
3. **models 级联删除**：删 provider 时 models 随之删除（ON DELETE CASCADE 需确认）
4. **logs 只增不删**：通过 logger.js 的 TRIM_INTERVAL 控制日志大小
