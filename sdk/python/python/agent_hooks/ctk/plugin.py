# Copyright (c) Microsoft. All rights reserved.

"""pytest plugin: ``pytest --agent-hooks-harness=... --agent-hooks-vectors=...``.

Without ``--agent-hooks-harness`` the built-in reference harness runs,
under the version ``--agent-hooks-spec`` names (``agent-hooks/0.1`` for
the gating run, ``agent-hooks/draft`` for the working test set).
"""

from __future__ import annotations

import functools
import importlib
from typing import Any

import pytest

from agent_hooks.ctk.runner import load_vectors, run_vector


def pytest_addoption(parser: pytest.Parser) -> None:
    g = parser.getgroup("agent-hooks")
    g.addoption("--agent-hooks-harness", default=None, help="module:Class of the Harness")
    g.addoption(
        "--agent-hooks-vectors",
        default=None,
        help="Path to a CTK vector directory (defaults to the packaged 0.1 suite)",
    )
    g.addoption(
        "--agent-hooks-spec",
        default=None,
        help=(
            "The specification version the built-in reference harness runs under "
            "(agent-hooks/0.1 or agent-hooks/draft); required when no harness is given"
        ),
    )


def _load_harness(target: str) -> type:
    mod, _, cls = target.rpartition(":") if ":" in target else target.rpartition(".")
    return getattr(importlib.import_module(mod), cls)


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "agent_hooks_vector" not in metafunc.fixturenames:
        return
    vdir = metafunc.config.getoption("--agent-hooks-vectors")
    vectors = load_vectors(vdir)  # None -> the set vendored in the wheel
    metafunc.parametrize("agent_hooks_vector", vectors, ids=[v["id"] for v in vectors])


@pytest.fixture
def agent_hooks_harness(request: pytest.FixtureRequest) -> Any:
    """A callable that builds the harness under test: the class named by
    ``--agent-hooks-harness``, or the reference harness under
    ``--agent-hooks-spec``."""
    target = request.config.getoption("--agent-hooks-harness")
    if target is None:
        spec = request.config.getoption("--agent-hooks-spec")
        if spec is None:
            raise pytest.UsageError(
                "--agent-hooks-spec names the specification version the reference "
                "harness runs under (agent-hooks/0.1 or agent-hooks/draft)"
            )
        from agent_hooks.ctk.reference import ReferenceHarness

        return functools.partial(ReferenceHarness, spec)
    return _load_harness(target)


@pytest.fixture
def agent_hooks_assert(agent_hooks_harness: Any, agent_hooks_vector: dict) -> None:
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
