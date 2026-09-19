"""ResilientModelMiddleware 纯单元测试（option2，E2E 真跑）。

用真 langchain 数据类（ModelRequest / ModelResponse，经 venv 实测非 frozen、
override() 可用）+ fake ChatModelFactory（鸭子实现真契约：unknown provider /
disabled model 抛 ValueError，同 harness_agent/llm/factory.py:186）。
零网络、零 harness_agent 运行时导入（中间件对其仅 TYPE_CHECKING 注解）。

尝试语义：第 0 次恒用 request.model，第 k 次(k>=1)取 backups[k-1]；
取模型失败（disabled/unknown）跳过该备用；总尝试数 = min(backup+1, max_failover+1)。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain.agents.middleware import ModelRequest, ModelResponse   # noqa: E402

from resilient_middleware import (   # noqa: E402
    ResilientModelMiddleware,
    _candidate_refs,
    _is_retryable,
)


# ----------------------------------------------------------------------------- fakes
class FakeChatModel:
    def __init__(self, ref):
        self.ref = ref

    def __repr__(self):
        return "FakeModel(%r)" % self.ref


class FakeFactory:
    def __init__(self, available, disabled=None):
        self._available = dict(available)
        self._disabled = disabled or set()
        self.calls = []

    def get_chat_model(self, ref):
        self.calls.append(ref)
        if ref in self._disabled:
            raise ValueError("Model %r disabled" % ref)
        if ref not in self._available:
            raise ValueError("Unknown provider or model: %r" % ref)
        return self._available[ref]   # 同一 ref -> 同一实例（缓存语义）


class RetryableError(Exception):
    def __init__(self, msg, status_code=None):
        super().__init__(msg)
        self.status_code = status_code
        if status_code is not None:
            self.response = type("Resp", (), {"status_code": status_code})()
        else:
            self.response = None


class NonRetryableError(Exception):
    def __init__(self, msg):
        super().__init__(msg)


def _make_request(model, messages=None):
    return ModelRequest(model=model, messages=messages or [])


# ----------------------------------------------------------------------------- helpers
def test_is_retryable_429():
    assert _is_retryable(RetryableError("429 Too Many Requests")) is True


def test_is_retryable_timeout_and_connection():
    assert _is_retryable(RetryableError("read timeout")) is True
    assert _is_retryable(RetryableError("connection reset")) is True
    assert _is_retryable(RetryableError("quota exceeded")) is True
    assert _is_retryable(RetryableError("rate limit")) is True


def test_is_retryable_5xx_via_status_code():
    assert _is_retryable(RetryableError("upstream", status_code=503)) is True
    assert _is_retryable(RetryableError("upstream", status_code=500)) is True


def test_is_retryable_not_4xx_business():
    assert _is_retryable(RetryableError("401 unauthorized", status_code=401)) is False
    assert _is_retryable(NonRetryableError("bad request")) is False


def test_candidate_refs_order():
    assert _candidate_refs("p/auto", ["b1/auto", "b2/auto"]) == ["p/auto", "b1/auto", "b2/auto"]
    assert _candidate_refs(None, ["b1/auto"]) == ["b1/auto"]
    assert _candidate_refs(None, []) == []


# ----------------------------------------------------------------------------- sync failover
def test_sync_no_failover_when_primary_ok():
    model = FakeChatModel("p/auto")
    factory = FakeFactory({"p/auto": model})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(model)
    seen = 0

    def handler(r):
        nonlocal seen
        seen += 1
        assert r.model is model          # 主模型未被换
        return ModelResponse(result=[r.model])

    resp = mw.wrap_model_call(req, handler)
    assert seen == 1
    assert isinstance(resp, ModelResponse)
    assert factory.calls == []           # 没换模型 -> 没碰 factory


def test_sync_failover_on_retryable_switches_to_backup():
    primary = FakeChatModel("p/auto")
    backup = FakeChatModel("b/auto")
    factory = FakeFactory({"p/auto": primary, "b/auto": backup})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(primary)
    first = True

    def handler(r):
        nonlocal first
        if first:
            first = False
            raise RetryableError("429 rate limit hit on primary")
        assert r.model is backup, "第二次应切到 backup 模型"
        return ModelResponse(result=[r.model])

    resp = mw.wrap_model_call(req, handler)
    assert isinstance(resp, ModelResponse)
    assert factory.calls == ["b/auto"], "failover 时确实取了一次 backup"


def test_sync_non_retryable_propagates_no_switch():
    factory = FakeFactory({"p/auto": FakeChatModel("p/auto"), "b/auto": FakeChatModel("b/auto")})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(FakeChatModel("p/auto"))

    def handler(r):
        raise NonRetryableError("400 bad request, should NOT failover")

    with pytest.raises(NonRetryableError, match="400"):
        mw.wrap_model_call(req, handler)
    assert factory.calls == [], "非 retryable 不应碰 factory"


def test_sync_exhausts_backups_then_raises_last():
    factory = FakeFactory({
        "p/auto": FakeChatModel("p/auto"),
        "b1/auto": FakeChatModel("b1/auto"),
        "b2/auto": FakeChatModel("b2/auto"),
    })
    mw = ResilientModelMiddleware(factory, backup_refs=["b1/auto", "b2/auto"], max_failover=3)
    req = _make_request(FakeChatModel("p/auto"))
    hits = 0

    def handler(r):
        nonlocal hits
        hits += 1
        raise RetryableError("503 at hit %d" % hits, status_code=503)

    with pytest.raises(RetryableError, match="503 at hit 3"):
        mw.wrap_model_call(req, handler)
    assert hits == 3
    assert factory.calls == ["b1/auto", "b2/auto"]


def test_sync_skips_disabled_backup_ref():
    primary = FakeChatModel("p/auto")
    b1 = FakeChatModel("b1/auto")
    b2 = FakeChatModel("b2/auto")
    factory = FakeFactory({"p/auto": primary, "b1/auto": b1, "b2/auto": b2}, disabled={"b1/auto"})
    mw = ResilientModelMiddleware(factory, backup_refs=["b1/auto", "b2/auto"])
    req = _make_request(primary)
    first = True

    def handler(r):
        nonlocal first
        if first:
            first = False
            raise RetryableError("429 on primary")
        assert r.model is b2, "应跳过 disabled b1，切到 enabled b2"
        return ModelResponse(result=[r.model])

    resp = mw.wrap_model_call(req, handler)
    assert isinstance(resp, ModelResponse)
    assert "b1/auto" in factory.calls and "b2/auto" in factory.calls
    assert factory.calls.index("b1/auto") < factory.calls.index("b2/auto")


def test_sync_respects_max_failover_limit():
    factory = FakeFactory({"p/auto": FakeChatModel("p/auto"), "b/auto": FakeChatModel("b/auto")})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto", "b2/auto"], max_failover=1)
    req = _make_request(FakeChatModel("p/auto"))
    hits = 0

    def handler(r):
        nonlocal hits
        hits += 1
        raise RetryableError("500 upstream", status_code=500)

    with pytest.raises(RetryableError):
        mw.wrap_model_call(req, handler)
    assert hits == 2, "max_failover=1 -> 最多 2 次尝试"
    assert factory.calls == ["b/auto"], "不越过 max_failover 试 b2"


# ----------------------------------------------------------------------------- async failover
def test_async_no_failover_when_primary_ok():
    model = FakeChatModel("p/auto")
    factory = FakeFactory({"p/auto": model})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(model)

    async def ahandler(r):
        assert r.model is model
        return ModelResponse(result=[r.model])

    resp = asyncio.run(mw.awrap_model_call(req, ahandler))
    assert isinstance(resp, ModelResponse)
    assert factory.calls == []


def test_async_failover_switches_to_backup():
    primary = FakeChatModel("p/auto")
    backup = FakeChatModel("b/auto")
    factory = FakeFactory({"p/auto": primary, "b/auto": backup})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(primary)
    first = True

    async def ahandler(r):
        nonlocal first
        if first:
            first = False
            raise RetryableError("429 async primary down")
        assert r.model is backup
        return ModelResponse(result=[r.model])

    out = asyncio.run(mw.awrap_model_call(req, ahandler))
    assert isinstance(out, ModelResponse)
    assert factory.calls == ["b/auto"]


def test_async_non_retryable_propagates():
    factory = FakeFactory({"p/auto": FakeChatModel("p/auto"), "b/auto": FakeChatModel("b/auto")})
    mw = ResilientModelMiddleware(factory, backup_refs=["b/auto"])
    req = _make_request(FakeChatModel("p/auto"))

    async def ahandler(r):
        raise NonRetryableError("async 400 should NOT failover")

    with pytest.raises(NonRetryableError, match="async 400"):
        asyncio.run(mw.awrap_model_call(req, ahandler))
    assert factory.calls == []


# ----------------------------------------------------------------------------- edge cases
def test_empty_backups_retryable_raises_last():
    factory = FakeFactory({})
    mw = ResilientModelMiddleware(factory, backup_refs=[])
    req = _make_request(FakeChatModel("p/auto"))

    def handler(r):
        raise RetryableError("500 no backups")

    with pytest.raises(RetryableError, match="500 no backups"):
        mw.wrap_model_call(req, handler)
    assert factory.calls == [], "无 backup，factory 不被取"


def test_primary_ref_semantic_not_fetched():
    factory = FakeFactory({"q/auto": FakeChatModel("q/auto"), "b/auto": FakeChatModel("b/auto")})
    mw = ResilientModelMiddleware(factory, backup_refs=["q/auto", "b/auto"], primary_ref="p/auto", max_failover=3)
    req = _make_request(FakeChatModel("p/auto"))
    hits = 0

    def handler(r):
        nonlocal hits
        hits += 1
        raise RetryableError("503 hit%d" % hits, status_code=503)

    with pytest.raises(RetryableError):
        mw.wrap_model_call(req, handler)
    assert factory.calls == ["q/auto", "b/auto"]
    assert hits == 3


def test_sync_and_async_share_is_retryable():
    for exc in (RetryableError("429"), RetryableError("connection reset"), RetryableError("x", status_code=502)):
        assert _is_retryable(exc) is True
