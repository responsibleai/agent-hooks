# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Unit tests for InterceptionRecord auditability fields (Q6)."""
from __future__ import annotations

import asyncio

from agent_hooks import ALLOW, Decision, InterceptionEmitter, Verdict
from agent_hooks.context import AgentContextBuilder


class _Allow:
    def intercept(self, context):
        return ALLOW


class _Deny:
    def intercept(self, context):
        return Verdict(decision=Decision.DENY, reason="test:deny")


def _ctx():
    b = AgentContextBuilder(agent_id="a", framework="test", session_id="sess-q6")
    return b.input(content="hi", role="user")


def test_decided_by_second_interceptor_denies() -> None:
    em = InterceptionEmitter()
    em.register(_Allow()).register(_Deny())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.decision is Decision.DENY
    assert record.decided_by == 1
    assert record.session_id == "sess-q6"
    assert record.sequence == 0


def test_decided_by_none_on_pure_allow() -> None:
    em = InterceptionEmitter()
    em.register(_Allow()).register(_Allow())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.decision is Decision.ALLOW
    assert record.decided_by is None


def test_decided_by_none_on_host_synthesized() -> None:
    em = InterceptionEmitter()  # zero interceptors -> host_error:no_interceptor
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.reason == "host_error:no_interceptor"
    assert record.decided_by is None


class _Raises:
    def intercept(self, context):
        raise RuntimeError("boom")


def test_failure_deny_attributed_to_failing_interceptor() -> None:
    # §10.3: a §6.3 failure deny carries the FAILING interceptor's
    # index, in every profile (D3, decisions/2026-07-11).
    em = InterceptionEmitter()
    em.register(_Allow()).register(_Raises()).register(_Allow())
    record = asyncio.run(em.emit_unchecked(_ctx()))
    assert record.verdict.reason == "host_error:interceptor_failed"
    assert record.decided_by == 1
    assert record.fold_truncated is True
