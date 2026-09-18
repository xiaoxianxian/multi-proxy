# option2 实现规范：把 multi-proxy 的 failover 韧性做成 Octop/harness-agent 中间件

> 本文档所有接口均来自 **实测的 PyPI wheel 源码**，不是凭记忆或 GitHub 推断。
> 关键事实：**`github.com/TencentCloud/harness-agent` 实测 404**（经代理 127.0.0.1:7897 返回 404），
> 但 **`orcakit-harness-agent` v1.0.11（MIT，基于 LangChain Deep Agents）在 PyPI 真实存在**，
> 且 wheel 是纯 Python（`py3-none-any`），**真实 `.py` 源码就打包在 wheel 里**。
> 所以"外部接口不能臆造"这个卡点已经解开：**源码真相在 wheel，不在 GitHub**。

---

## 0. 怎么复现这份源码（你自己也能拉）

```bash
pip download orcakit-harness-agent --no-deps -d ./harness_pkg
# 解压（wheel 是 zip）
python -m zipfile -e harness_pkg/orcakit_harness_agent-*.whl ./harness_pkg/extracted
# 关键目录：./harness_pkg/extracted/harness_agent/
```

本文引用的 `file:line` 都基于 `harness_agent/` 这个包根目录。

---

## 1. 你要接的"真接口"清单（全部实测）

### 1.1 中间件契约：`langchain.agents.middleware.AgentMiddleware`

来源：`harness_agent/middleware/model_router.py:19-23`（import 自 langchain，不是 harness 自创）

```python
from langchain.agents.middleware import (
    AgentMiddleware,   # 基类
    ModelRequest,      # 请求：含 .model（一个 BaseChatModel 实例）和 .messages
    ModelResponse,     # 响应
)
```

你的 failover 中间件要继承 `AgentMiddleware[Any, Any]`，并实现两个方法（同步 + 异步）：

```python
class ResilientModelMiddleware(AgentMiddleware[Any, Any]):
    def wrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
    ) -> ModelResponse: ...
    async def awrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
    ) -> ModelResponse: ...
```

- `request.model` 是一个 `langchain_core.language_models.BaseChatModel` 实例（即真正要调用的模型对象）。
- `handler(request)` 会真正去调模型，**返回 `ModelResponse`**。
- 你要在 `handler` 外包一层 try/except：抛 retryable 异常时，把 `request.model` 换成备用模型（从 factory 取），再调一次 `handler(request)`。

> 这是关键：harness 的中间件机制就是把 `request.model` 这个对象换掉再交给下游 handler，**不需要动任何内核代码**。

### 1.2 范例：官方 `ModelRouterMiddleware` 就是这么干的

来源：`harness_agent/middleware/model_router.py:35-92`

```python
class ModelRouterMiddleware(AgentMiddleware[Any, Any]):
    def __init__(self, config, factory, *, get_protocol=None):
        self._config = config
        self._factory = factory          # ← ChatModelFactory 实例
        self._get_protocol = get_protocol

    def wrap_model_call(self, request, handler):
        request.model = self._select_model(request)   # ← 换模型
        return handler(request)                       # ← 交给下游

    def _select_model(self, request):
        ref = self._select_ref(request)
        if self._get_protocol is not None:
            return self._factory.get(ref, get_protocol=self._get_protocol).chat_model
        return self._factory.get_chat_model(ref)
```

**你的 `ResilientModelMiddleware` 只需改一件事**：不换"用哪个模型"（那是 router 的活），而是在 `handler(request)` 外包 failover——失败时换 `request.model` 为备用 ref 对应的 `BaseChatModel` 再调。

### 1.3 取备用模型的工厂：`ChatModelFactory`

来源：`harness_agent/llm/factory.py`

| 方法 | 签名 | 用途 |
|---|---|---|
| 构造 | `ChatModelFactory(providers: list[ProviderConfig], *, agent_config=None, get_protocol=None)` | 持有全部 provider/model |
| 取模型对象 | `get_chat_model(model_ref: str) -> BaseChatModel` | **failover 时换模型用这个** |
| 取访问句柄 | `get(model_ref) -> ModelAccess`（含 `.chat_model`） | router 用的完整句柄 |
| 列出全部 ref | `list_refs(enabled_only=True) -> list[str]` | 如 `"deepseek/chat"` 形式 |
| 解析 ref | `resolve_ref(spec, *, messages=None, configurable=None) -> str` | `"auto"`/角色名/`"provider/model"` |

- `model_ref` 格式是 `"<provider_id>/<model_id>"`（见 `factory.py:151`、`factory.py:191`）。
- 模型对象是**缓存复用**的（`factory.py:188` 的 `_cache`），换模型不会重复构造。

### 1.4 注入点：`HarnessAgentConfig.middleware`

来源：`harness_agent/config/__init__.py:526` 与 `harness_agent/agent.py:1494-1495`

```python
# config/__init__.py:526
middleware: list[Any] | None = None
```

```python
# agent.py:1494 —— 在 _build_middleware() 里，用户中间件插在 memory 之后、team 之前
if cfg.middleware:
    chain.extend(cfg.middleware)
```

**这就是你的中间件被加载的唯一官方入口**：把实例放进 `HarnessAgentConfig.middleware` 列表即可，无需 fork、无需改 agent.py。

### 1.5 配置对象字段（注入你的 provider 时用）

来源：`harness_agent/config/__init__.py`

**`ProviderConfig`（dataclass，`:263` 起）** 实测字段：
- `id: str` — provider 标识（ref 的前半段）
- `base_url: str` — 你的 `codex-proxy` 就是填这里，如 `http://127.0.0.1:18790/v1`
- `api_key: str`
- `name: str = ""`
- `protocol: str` — `"openai"` / `"anthropic"` / `"bedrock"`（见 `factory.py:225-231`）
- `models: list[ModelConfig]`
- `stream_usage`、`headers`、`session_header`（可选）

**`ModelConfig`（dataclass，`:140` 起）** 实测字段：
- `id: str`、`name: str = ""`、`enabled: bool = True`
- `input: list[InputModality]`（默认 `["text"]`，多模态路由用）
- `thinking: bool | None = None`
- `max_input_tokens / context_window / max_output_tokens: int = 0`
- `native_tool_search: bool = False`
- `capabilities: tuple[str, ...] = ()`

### 1.6 已存在的缺口：官方只有"单模型重试"，没有"跨 provider failover"

来源：`harness_agent/agent.py:1457-1464` + `config/__init__.py:453-456`

```python
if cfg.model_retry_enabled:
    chain.append(ModelRetryMiddleware(
        max_retries=cfg.model_retry_max_retries,        # 默认 2
        initial_delay=cfg.model_retry_initial_delay,    # 默认 1.0
        max_delay=cfg.model_retry_max_delay,            # 默认 60.0
    ))
```

`ModelRetryMiddleware` 只在**同一个模型**上重试，**不跨 provider 切换**。这正是你 multi-proxy 的 failover（A 限速→切 B）要补的空档。
注意：集成时建议关闭官方 `model_retry_enabled`（或把你的 failover 放在它前面/后面协调），避免双重重试放大延迟。

---

## 2. 设计草案：`ResilientModelMiddleware`（Python，遵循上面真契约）

```python
# resilient_middleware.py
from __future__ import annotations
from collections.abc import Awaitable, Callable
from typing import Any
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from harness_agent.llm.factory import ChatModelFactory


def _is_retryable(exc: Exception) -> bool:
    """判定是否可 failover：429 / 5xx / 超时 / 连接错误。
    复用你 multi-proxy 里 circuit-breaker 的判定逻辑（端口这里用 Python 重写）。"""
    msg = str(exc).lower()
    if "429" in msg or "rate" in msg or "quota" in msg:
        return True
    if "timeout" in msg or "connection" in msg or "reset" in msg:
        return True
    # langchain/openai 的 HTTPStatusError 带 status_code
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status is not None and status >= 500:
        return True
    return False


class ResilientModelMiddleware(AgentMiddleware[Any, Any]):
    """跨 provider 的 failover 中间件：主模型 retryable 失败时，
    按 backup_refs 顺序换 BaseChatModel 重试。"""

    def __init__(
        self,
        factory: ChatModelFactory,
        backup_refs: list[str],
        *,
        max_failover: int = 3,
        primary_ref: str | None = None,
    ) -> None:
        self._factory = factory
        self._backups = backup_refs
        self._max = max_failover
        self._primary = primary_ref

    def _call_with_failover(self, request, handler):
        last_exc: Exception | None = None
        candidates = ([self._primary] if self._primary else []) + self._backups
        for i, ref in enumerate(candidates[: self._max + 1]):
            # 第一次用 request.model 原值（可能已被 router 设定）；之后换备用
            if i > 0:
                try:
                    request.model = self._factory.get_chat_model(ref)
                except Exception:
                    continue
            try:
                return handler(request)
            except Exception as exc:  # noqa: BLE001
                if not _is_retryable(exc):
                    raise
                last_exc = exc
                continue
        if last_exc is not None:
            raise last_exc
        return handler(request)

    def wrap_model_call(self, request, handler):
        return self._call_with_failover(request, handler)

    async def awrap_model_call(self, request, handler):
        # 异步版：handler 是 awaitable，try/except 结构相同
        last_exc = None
        candidates = ([self._primary] if self._primary else []) + self._backups
        for i, ref in enumerate(candidates[: self._max + 1]):
            if i > 0:
                try:
                    request.model = self._factory.get_chat_model(ref)
                except Exception:
                    continue
            try:
                return await handler(request)
            except Exception as exc:  # noqa: BLE001
                if not _is_retryable(exc):
                    raise
                last_exc = exc
        if last_exc is not None:
            raise last_exc
        return await handler(request)
```

### 注册方式（不 fork）

```python
from harness_agent.config import HarnessAgentConfig, ProviderConfig, ModelConfig
from harness_agent.llm.factory import ChatModelFactory
from resilient_middleware import ResilientModelMiddleware

providers = [
    ProviderConfig(
        id="myproxy",
        base_url="http://127.0.0.1:18790/v1",   # ← 你的 codex-proxy（多 provider failover）
        api_key="sk-...",
        protocol="openai",
        models=[ModelConfig(id="auto")],          # harness 侧只看到一个"通道"
    ),
    # 备用 provider（同机另一个代理，或直接其它上游）
    ProviderConfig(
        id="backup", base_url="http://127.0.0.1:18794/v1",
        api_key="sk-...", protocol="openai",
        models=[ModelConfig(id="auto")],
    ),
]

factory = ChatModelFactory(providers)
cfg = HarnessAgentConfig(
    # ... 其它配置
    middleware=[ResilientModelMiddleware(factory, backup_refs=["backup/auto"])],
    model_retry_enabled=False,   # 关掉官方单模型重试，避免双重重试
)
```

> 注意：`codex-proxy` 本身已经做了"多上游 failover"，所以你其实有**两层**韧性：
> 1. 外层：harness 的 `ResilientModelMiddleware` 在 `myproxy` 整条通道挂掉时切到 `backup` 通道；
> 2. 内层：`codex-proxy` 在自己上游（DeepSeek/Moonshot/Agnes）之间 failover。
> 这是 Octop/harness-agent 原生完全没有的双层韧性。

---

## 3. 与你 multi-proxy 已有能力的映射（复用，不是重写）

| 你已有的（Node/TS，在 multi-proxy 里） | 在 harness 中间件里怎么用 |
|---|---|
| `l2/circuit-breaker.js`（熔断状态机） | 移植成 Python：在 `_call_with_failover` 里按 provider 维护熔断计数，熔断的直接跳过该 ref |
| `l2/rate-limiter.js`（令牌桶） | 移植成 Python：发请求前按 ref 取令牌，没令牌换下一个 |
| `l2/health-monitor`（provider 健康） | 移植成 Python：维护一张 `ref → health` 表，`_is_retryable` 命中后顺手标记降级 |
| `codex-proxy` 的 OpenAI 兼容端点 | 直接当 `ProviderConfig.base_url`，零改动 |

**重点**：harness 这边是 Python 运行时，你 Node/TS 的 L2 模块不能直接 import，需要**用 Python 重写一遍逻辑**（逻辑你已经验证过，重写是体力活不是设计活）。或者——更省事——直接把 `codex-proxy(:18790)` 当唯一 provider 暴露给 harness，让**内层 failover 仍跑在你的 Node 进程里**，harness 中间件只负责"通道级"切换。后者改动量最小。

---

## 4. 落地步骤（最小改动优先）

1. **最小可用（今天就能验证）**：只做第 0 节 + 第 2 节"注册方式"，把 `:18790` 当唯一 provider，先不写 failover 逻辑，确认 harness-agent 能经你的代理出 token。
2. **加通道级 failover**：写 `ResilientModelMiddleware`，备用 ref 指向 `:18794`（cursor-proxy，自带熔断/限流/AES 加密），关掉官方 `model_retry_enabled`。
3. **（可选）加细粒度韧性**：把 circuit-breaker/rate-limiter 移植 Python，做 provider 级熔断。
4. **验证**：构造一个"让 `:18790` 返回 429"的测试，确认 harness 自动切到 `:18794` 并拿到正常响应。

---

## 5. 参考资源清单（都是真实可查的）

| 资源 | 位置 | 用途 |
|---|---|---|
| 中间件契约基类 | `langchain.agents.middleware.AgentMiddleware` | 你的基类 |
| 官方范例 | `harness_agent/middleware/model_router.py:35-92` | 照这个写 |
| 模型工厂 | `harness_agent/llm/factory.py:52`（`get_chat_model` `:186`） | 换模型用 |
| 注入点 | `harness_agent/config/__init__.py:526`（`middleware` 字段） | 注册入口 |
| 链装配 | `harness_agent/agent.py:1494-1495` | 确认中间件被加载 |
| 官方单模型重试（缺口对照） | `harness_agent/agent.py:1457-1464` | 你的 failover 补这里 |
| Provider/Model 配置 | `harness_agent/config/__init__.py:140`(Model) / `:263`(Provider) | 填 provider 用 |
| wheel 本地源码 | `./harness_pkg/extracted/harness_agent/`（你自己 `pip download` 得到） | 随时翻真源码 |

---

## 6. 一句话结论

你 option2 的"外部接口依赖"已经解除：**源码真相在 PyPI wheel，不在 GitHub**。
真接口就是标准 LangChain `AgentMiddleware` 契约 + `HarnessAgentConfig.middleware` 注入槽。
你的 failover 做成 `ResilientModelMiddleware` 后，**零 fork、零改 harness 内核**就能被 Octop 的任意专家加载，
而且因为是"通道级 + 内层 proxy 双韧性"，比 harness 原生的单模型重试强一个层级。
