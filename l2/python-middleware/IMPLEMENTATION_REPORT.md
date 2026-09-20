# ResilientModelMiddleware 实施报告

## 概述
option2 的 Python failover 中间件 `ResilientModelMiddleware` 已实现在 `l2/python-middleware/`，并通过 17 项真实单元测试验证（零 mock 网络、零 harness-agent 运行时依赖）。

---

## 关键环境事实（实测）

| 项 | 值 |
|---|---|
| Python 版本 | `/opt/homebrew/bin/python3.12` (3.12.13) |
| venv 路径 | `/tmp/octop-impl/venv` |
| langchain 版本 | 1.4.2（通过 `pip install langchain langchain-core`） |
| harness-agent 版本 | v1.0.12（从 `/tmp/octop-probe/pkg/orcakit_harness_agent-1.0.12-py3-none-any.whl` 安装） |
| 网络代理 | `http://127.0.0.1:7897`（PyPI 需走代理） |
| deepagents 状态 | PyPI 404，**harness-agent 仅以 `--no-deps` 安装**（中间件不依赖 deepagents） |

---

## 接口核验（基于 wheel 真源码）

1. **`langchain.agents.middleware.AgentMiddleware`** — `pkg/orcakit_harness_agent-1.0.12` wheel 中引用的基类
   - 真 import 路径：`from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse`
   - 已用 `/tmp/octop-impl/venv/bin/python -c "..."` 实测验证通过

2. **`ChatModelFactory.get_chat_model(ref)`** — `factory.py:186`
   - 签名：`get_chat_model(model_ref: str) -> BaseChatModel`
   - 未知 provider / disabled model 抛 `ValueError`
   - 实例缓存复用（`self._cache[model_ref] = instance`）

3. **官方范例** — `middleware/model_router.py:35-92`
   - 照 `ModelRouterMiddleware` 写法，把换模型逻辑包进 try/except

4. **注入点** — `config/__init__.py:526` (`middleware: list[Any] | None = None`)
   - 与 `agent.py:1494-1495` 的 `chain.extend(cfg.middleware)` 对应

5. **ProviderConfig** — `config/__init__.py:263` 实测字段：`id`, `base_url`, `api_key`, `protocol`, `models`

---

## 实现文件

```
/Users/xiaota/Documents/AI项目/multi-proxy/l2/python-middleware/resilient_middleware.py
```

### 真 import vs stand-in 标注

| 行 | 内容 | 状态 |
|---|---|---|
| `from langchain.agents.middleware import (AgentMiddleware, ModelRequest, ModelResponse)` | **真 import**（langchain 1.4.2 已安装） | ✓ |
| `from harness_agent.llm.factory import ChatModelFactory` | **TYPE_CHECKING 仅注解**，鸭子调用 `factory.get_chat_model()` | ✓（无需真 import） |
| `class ResilientModelMiddleware(AgentMiddleware[Any, Any])` | **真基类继承** | ✓ |
| `wrap_model_call` / `awrap_model_call` | **真方法签名**（与 spec §1.1 完全一致） | ✓ |
| `_is_retryable` | 复用 multi-proxy L2 circuit-breaker 判定口径（429/rate/quota/timeout/connection/reset/5xx） | ✓ |
| `_candidate_refs` / `_SkipBackup` | 内部辅助 | ✓ |

---

## 测试文件

```
/Users/xiaota/Documents/AI项目/multi-proxy/l2/python-middleware/test_resilient_middleware.py
```

### 测试覆盖

| 测试 | 断言 |
|---|---|
| `test_is_retryable_429` | 429 消息可重试 |
| `test_is_retryable_timeout_and_connection` | timeout/connection/reset/quota/rate 可重试 |
| `test_is_retryable_5xx_via_status_code` | HTTPStatusError.status_code >= 500 可重试 |
| `test_is_retryable_not_4xx_business` | 400/401/业务错不可重试 |
| `test_sync_no_failover_when_primary_ok` | 主模型成功 → 不调 factory |
| `test_sync_failover_on_retryable_switches_to_backup` | 主模型抛 429 → 切 backup 成功 |
| `test_sync_non_retryable_propagates_no_switch` | 非 retryable → 原样上抛，factory.calls == [] |
| `test_sync_exhausts_backups_then_raises_last` | 全 backup 挂 → raise last_exc |
| `test_sync_skips_disabled_backup_ref` | disabled 备用跳过，继续下一个 |
| `test_sync_respects_max_failover_limit` | max_failover=1 → 最多 2 次尝试 |
| `test_async_*` (3 项) | async handler 同构同步逻辑 |
| `test_empty_backups_retryable_raises_last` | 无 backup → 原异常上抛 |
| `test_primary_ref_semantic_not_fetched` | primary_ref 语义正确（不触发 factory 取模型） |

### 测试结果

```
17 passed in 0.19s
```

---

## 核心断言验证（必须条件）

✅ **① 主模型失败 → 自动切备用**
- `test_sync_failover_on_retryable_switches_to_backup`: handler 第一次抛 `RetryableError("429")`，第二次返回 backup 模型 → 断言 `r.model is backup`

✅ **② 非 retryable 异常向上抛（不重试）**
- `test_sync_non_retryable_propagates_no_switch`: handler 抛 `NonRetryableError("400")` → pytest.raises(NonRetryableError)，`factory.calls == []`

✅ **③ 全备用都挂才 raise last_exc**
- `test_sync_exhausts_backups_then_raises_last`: 3 次 handler 全部抛 503 → `pytest.raises(RetryableError, match="503 at hit 3")`，`factory.calls == ["b1/auto", "b2/auto"]`

---

## 运行命令

```bash
# 建 venv（已完成）
/opt/homebrew/bin/python3.12 -m venv /tmp/octop-impl/venv

# 装依赖
export ALL_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897
/tmp/octop-impl/venv/bin/pip install --quiet langchain-core langchain pytest
/tmp/octop-impl/venv/bin/pip install --no-deps /tmp/octop-probe/pkg/orcakit_harness_agent-1.0.12-py3-none-any.whl

# 运行测试
cd /Users/xiaota/Documents/AI项目/multi-proxy/l2/python-middleware
/tmp/octop-impl/venv/bin/python -m pytest test_resilient_middleware.py -v
```

---

## 结论

**已完成**。`ResilientModelMiddleware` 实现完整，17/17 测试通过。核心契约（`AgentMiddleware[Any, Any]` 基类 + `ModelRequest/ModelResponse` 真数据类 + 鸭子调用 `ChatModelFactory.get_chat_model()`）全部基于实测源码，非臆造。

### 未被实现的部分（诚实标注）

1. **`deepagents` 包不可达**：harness-agent v1.0.12 依赖 `deepagents<0.8,>=0.7`，PyPI 404，无法完整安装 harness-agent 运行时。但本中间件仅依赖 `langchain.agents.middleware`（已装），`harness_agent.llm.factory.ChatModelFactory` 仅作 TYPE_CHECKING 注解，运行时鸭子调用，不影响功能。

2. **无端到端 harness-agent 集成测试**：当前测试用 `FakeFactory`（鸭子实现 `get_chat_model()` 契约），未用真实 harness-agent agent 跑一遍。如需要，需解决 deepagents 依赖问题或从本地 wheel 手动解压后 monkey-patch。

3. **未与 multi-proxy L2 熔断/限流联动**：spec §3 提到的 circuit-breaker/rate-limiter Python 移植为后续工作。

---

## 产出文件

| 文件 | 路径 |
|---|---|
| 实现 | `/Users/xiaota/Documents/AI项目/multi-proxy/l2/python-middleware/resilient_middleware.py` |
| 测试 | `/Users/xiaota/Documents/AI项目/multi-proxy/l2/python-middleware/test_resilient_middleware.py` |
| venv | `/tmp/octop-impl/venv` |

---

*报告生成时间：2026-09-20*
*基于 specs/docs/octop-harness-failover-middleware-spec.md (319 行) + wheel 实测源码*
