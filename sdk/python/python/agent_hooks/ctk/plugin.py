# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""pytest plugin: ``pytest --agent-hooks-harness=... --agent-hooks-vectors=...``."""

from __future__ import annotations

import importlib

import pytest

from agent_hooks.ctk.runner import load_vectors, run_vector


def pytest_addoption(parser: pytest.Parser) -> None:
    g = parser.getgroup("agent-hooks")
    g.addoption("--agent-hooks-harness", default=None, help="module:Class of the Harness")
    g.addoption(
        "--agent-hooks-vectors",
        default=None,
        help="Path to conformance/vectors/ (defaults to repo-relative)",
    )


def _load_harness(spec: str) -> type:
    mod, _, cls = spec.rpartition(":") if ":" in spec else spec.rpartition(".")
    return getattr(importlib.import_module(mod), cls)


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "agent_hooks_vector" not in metafunc.fixturenames:
        return
    vdir = metafunc.config.getoption("--agent-hooks-vectors")
    vectors = load_vectors(vdir)  # None -> the set vendored in the wheel
    metafunc.parametrize("agent_hooks_vector", vectors, ids=[v["id"] for v in vectors])


@pytest.fixture
def agent_hooks_harness(request: pytest.FixtureRequest) -> type:
    spec = request.config.getoption("--agent-hooks-harness")
    if spec is None:
        from agent_hooks.ctk.reference import ReferenceHarness

        return ReferenceHarness
    return _load_harness(spec)


@pytest.fixture
def agent_hooks_assert(agent_hooks_harness: type, agent_hooks_vector: dict) -> None:
    """Drop-in fixture that runs one vector and asserts/skips.

    Usage in a downstream test module::

        def test_conformance(agent_hooks_assert):
            pass
    """
    import asyncio

    result = asyncio.run(run_vector(agent_hooks_harness(), agent_hooks_vector))
    if result.status == "skip":
        pytest.skip(result.detail)
    assert result.status == "pass", "\n".join(result.failures)
