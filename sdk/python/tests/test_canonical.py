# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Unit tests for §10 canonical JSON and context identity."""

from __future__ import annotations

from agent_hooks import canonical_json, context_identity
from agent_hooks.context import AgentContextBuilder


def test_canonical_sorts_keys() -> None:
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonical_no_whitespace() -> None:
    assert " " not in canonical_json({"a": [1, 2, {"b": 3}]})


def test_canonical_integral_float() -> None:
    assert canonical_json(1.0) == "1"
    assert canonical_json(-0.0) == "0"


def test_canonical_nested_determinism() -> None:
    a = {"x": {"b": 1, "a": 2}, "y": [3, 2, 1]}
    b = {"y": [3, 2, 1], "x": {"a": 2, "b": 1}}
    assert canonical_json(a) == canonical_json(b)


def test_identity_strips_l2_and_extensions() -> None:
    b = AgentContextBuilder(agent_id="a", framework="ref", session_id="s")
    ctx = b.input(content="hi", role="user")
    base = context_identity(ctx)
    ctx["trace"] = {"trace_id": "t"}
    ctx["extensions"] = {"acs": {"foo": 1}}
    ctx["agent"]["name"] = "ignored-l2"
    assert context_identity(ctx) == base


def test_identity_changes_with_target() -> None:
    b = AgentContextBuilder(agent_id="a", framework="ref", session_id="s")
    ctx1 = b.input(content="hi", role="user")
    b2 = AgentContextBuilder(agent_id="a", framework="ref", session_id="s")
    ctx2 = b2.input(content="bye", role="user")
    # sequence and timestamp differ; normalize for the assertion
    ctx2["sequence"] = ctx1["sequence"]
    ctx2["timestamp"] = ctx1["timestamp"]
    assert context_identity(ctx1) != context_identity(ctx2)


def test_identity_format() -> None:
    b = AgentContextBuilder(agent_id="a", framework="ref", session_id="s")
    ctx = b.agent_startup(tools_registered=[])
    cid = context_identity(ctx)
    assert cid.startswith("sha256:")
    assert len(cid) == len("sha256:") + 64
