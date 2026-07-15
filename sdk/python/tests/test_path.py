# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Unit tests for §5.2 transform path grammar and application."""

from __future__ import annotations

import pytest
from agent_hooks._types import HostError
from agent_hooks.path import PathError, apply, parse, resolve


def test_parse_root_only() -> None:
    assert parse("$target") == []


def test_parse_dot_and_index() -> None:
    assert parse("$target.a.b[0].c") == ["a", "b", 0, "c"]


def test_parse_bracket_member() -> None:
    assert parse('$target["weird-key"]') == ["weird-key"]


def test_parse_policy_target_alias() -> None:
    assert parse("$policy_target.x") == ["x"]


def test_parse_rejects_foreign_root() -> None:
    with pytest.raises(PathError) as ei:
        parse("$snapshot.x")
    assert ei.value.host_error is HostError.TRANSFORM_TARGET_FORBIDDEN


def test_resolve_and_apply() -> None:
    target = {"a": {"b": [10, 20]}}
    assert resolve(target, "$target.a.b[1]") == 20
    # apply() delegates to the Rust core across the FFI boundary, so it
    # returns a new object rather than mutating in place.
    out = apply(target, "$target.a.b[1]", 99)
    assert out["a"]["b"][1] == 99
    assert target["a"]["b"][1] == 20


def test_apply_root_replacement() -> None:
    assert apply({"x": 1}, "$target", "new") == "new"


def test_apply_unresolvable() -> None:
    with pytest.raises(PathError) as ei:
        apply({"a": 1}, "$target.missing.deeper", 0)
    assert ei.value.host_error is HostError.TRANSFORM_INVALID
