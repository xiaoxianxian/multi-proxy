"""ResilientModelMiddleware — cross-provider failover 中间件 (option2)。

设计依据：docs/octop-harness-failover-middleware-spec.md（319 行，基于 PyPI
orcakit-harness-agent v1.0.11 wheel 实测源码，commit c5562ef）。

补 harness 原生的空档：官方只有 ModelRetryMiddleware（同一模型上重试，见
harness_agent/agent.py:1457 + config/__init__.py:453），不跨 provider 切换。
本中间件在主模型 handler 抛 retryable 异常时，按 backup_refs 顺序把
request.model 换成备用 BaseChatModel（从 ChatModelFactory 取）再调一次，
即 "A 限速/故障 -> 切 B" 的 failover。

契约（经 wheel 真源码核实，非臆造）：
  from langchain.agents.middleware import (AgentMiddleware, ModelRequest, ModelResponse)
  ChatModelFactory.get_chat_model(ref) -> BaseChatModel
  （factory.py:186，unknown provider / disabled model 抛 ValueError）

尝试语义（spec §2）：
  第 0 次恒用 request.model（上游 router / 主路径已设定，不取 factory）；
  第 k 次(k>=1) 取 backups[k-1] 换模型；
  取模型失败（缺 provider / disabled）跳过该备用；
  总尝试数 = min(backup 数 + 1, max_failover + 1)。

与官方 ModelRetryMiddleware（同模型 retry=2）正交：外层（本件）切 provider，
内层（codex-proxy）切上游。部署时建议关官方 model_retry_enabled 或让本件排其后，
避免双重重试放大延迟（spec §1.6）。

_is_retryable 判定口径与 Node 侧 l2/circuit-breaker.js
（429/quota/rate/timeout/connection/reset/5xx）一致，两侧熔断判定同源。
harness 运行时零重依赖：仅 import langchain.agents.middleware 三符号，
ChatModelFactory / HarnessAgentConfig 仅作 TYPE_CHECKING 注解，鸭子调用，
不进 harness_agent 包树。

primary_ref 为 spec §2 __init__ 兼容参数：第 0 次恒用 request.model，
primary_ref 本身不触发取模型，序列里仍由 backups 在 k>=1 时按序补位。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

# 中间件基类 + 真数据类（langchain 原生，非 harness 自创，spec §1.1）。
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)

if TYPE_CHECKING:
    # 仅注解用；运行时不导入 harness_agent（鸭子调用 factory.get_chat_model）。
    from harness_agent.llm.factory import ChatModelFactory as _ChatModelFactory


_NO_ATTEMPTS = RuntimeError(
    "ResilientModelMiddleware: no candidate model attempts succeeded"
)


class _SkipBackup(Exception):
    """解析出的备用与当前是同一实例，换 = 没换，跳过本次尝试。"""

    def __init__(self, ref: str) -> None:
        super().__init__(ref)
        self.ref = ref


def _has_override_method(request: ModelRequest) -> bool:
    """是否支持 langchain 推荐的不可变 override（返回新 request）。"""
    return callable(getattr(request, "override", None))


def _apply_model(request: ModelRequest, model: Any) -> ModelRequest:
    """换模型健壮版：优先 override（不可变、推荐），回退直接赋值（兼容旧形态）。"""
    if _has_override_method(request):
        return request.override(model=model)
    request.model = model   # type: ignore[attr-defined]
    return request


def _is_retryable(exc: BaseException) -> bool:
    """判定是否可 failover：429 / rate / quota / timeout / connection / reset / 5xx。

    口径与 Node 侧 l2/circuit-breaker.js 一致，保证两侧熔断语义同源。
    非 retryable（400 参数错 / 401 鉴权 / 业务逻辑错）立即上抛，不切换模型。
    """
    msg = str(exc).lower()
    if "429" in msg or "rate" in msg or "quota" in msg:
        return True
    if "timeout" in msg or "connection" in msg or "reset" in msg:
        return True
    # openai / httpx 的 HTTPStatusError 带 response.status_code
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status is not None and status >= 500:
        return True
    return False


def _candidate_refs(primary_ref: str | None, backups: list[str]) -> list[str]:
    """failover 候选序列 [primary_ref?] + backups（spec §2，primary 在首，仅语义用）。"""
    refs: list[str] = []
    if primary_ref:
        refs.append(primary_ref)
    refs.extend(backups)
    return refs


class ResilientModelMiddleware(AgentMiddleware[Any, Any]):
    """跨 provider 的 failover 中间件：主模型 retryable 失败时按 backup_refs 顺序换模型重试。

    注入方式（不 fork，spec §1.4）::

        from harness_agent.config import HarnessAgentConfig
        from harness_agent.llm.factory import ChatModelFactory
        from resilient_middleware import ResilientModelMiddleware

        factory = ChatModelFactory([primary_provider, backup_provider])
        cfg = HarnessAgentConfig(
            middleware=[ResilientModelMiddleware(factory, backup_refs=["backup/auto"])],
            model_retry_enabled=False,    # 关官方单模型重试，避免双重重试
        )
    """

    def __init__(
        self,
        factory: "_ChatModelFactory",
        backup_refs: list[str],
        *,
        max_failover: int = 3,
        primary_ref: str | None = None,
    ) -> None:
        # AgentMiddleware.__init__(self) 无参（实测 langchain 1.x），显式调以对齐契约。
        super().__init__()
        self._factory = factory
        self._backups = list(backup_refs)
        self._max = max_failover
        self._primary = primary_ref

    # ---------------------------------------------------------------- public

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        """同步入口：handler 为同步 fn；failover 后返回成功响应。"""
        return self._run_sync(request, handler)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        """异步入口：handler 是 async fn，await 后 failover。

        与官方 ModelRouterMiddleware.awrap_model_call 同构（spec §1.2），只是把
        failover 的 try/except 包在 await handler 外层。
        """
        return await self._run_async(request, handler)

    # ---------------------------------------------------------------- internals

    def _attempts(self) -> int:
        """总尝试数 = min(backup 数 + 1, max_failover + 1)。"""
        return min(len(self._backups) + 1, self._max + 1)

    def _acquire_backup(self, current: ModelRequest, k: int) -> ModelRequest:
        """取备用模型并换到 current 上返回新 request。

        k 指当前尝试序号（>= 1），取 backups[k-1]；解析出的模型与当前同一实例
        （换 = 没换）抛 _SkipBackup，由调用方吞掉跳过，避免「换个等于没换」空转。
        """
        ref = self._backups[k - 1]
        new_model = self._factory.get_chat_model(ref)   # type: ignore[attr-defined]
        if new_model is current.model:
            raise _SkipBackup(ref)
        return _apply_model(current, new_model)

    def _run_sync(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        attempts = self._attempts()
        last_exc: BaseException | None = None
        current = request
        for k in range(attempts):
            if k > 0:
                try:
                    current = self._acquire_backup(current, k)
                except _SkipBackup:
                    continue
                except Exception:   # noqa: BLE001 — 缺 provider/disabled 跳该备用
                    continue
            try:
                result: Any = handler(current)
                if asyncio.iscoroutine(result):   # 防御：意外接到 async handler
                    result = asyncio.run(result)
                return result
            except Exception as exc:   # noqa: BLE001 — 仅 retryable 继续 failover
                if not _is_retryable(exc):
                    raise
                last_exc = exc
        if last_exc is not None:
            raise last_exc
        raise _NO_ATTEMPTS

    async def _run_async(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        attempts = self._attempts()
        last_exc: BaseException | None = None
        current = request
        for k in range(attempts):
            if k > 0:
                try:
                    current = self._acquire_backup(current, k)
                except _SkipBackup:
                    continue
                except Exception:   # noqa: BLE001 — 取模型失败跳该备用
                    continue
            try:
                return await handler(current)
            except Exception as exc:   # noqa: BLE001
                if not _is_retryable(exc):
                    raise
                last_exc = exc
        if last_exc is not None:
            raise last_exc
        raise _NO_ATTEMPTS


__all__ = [
    "ResilientModelMiddleware",
    "_is_retryable",
    "_candidate_refs",
]
