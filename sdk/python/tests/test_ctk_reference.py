# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""CTK self-test: run all vectors against the in-tree ReferenceHarness."""

from __future__ import annotations

import asyncio
import pathlib

import pytest
from agent_hooks.ctk import load_vectors, run_vector
from agent_hooks.ctk.reference import ReferenceHarness

_VECTORS = pathlib.Path(__file__).resolve().parents[3] / "conformance" / "vectors"

# Pinned skip set: Python ints are arbitrary precision, so the
# reference harness declares every value-domain capability and no
# value-domain vector may skip. The streaming/incremental part (§12.1
# exception) skips because the reference harness buffers caller-bound
# output and does not declare incremental_output. The declaration/*
# parts (§7.7.9) run: the harness declares host_declaration and builds
# every emitter through the loader. Any other skip means a capability
# regressed or a vector was quietly excluded; both must fail the suite.
EXPECTED_SKIPS: frozenset[str] = frozenset({"AH-CTK-110", "AH-CTK-111", "AH-CTK-112", "AH-CTK-113"})


@pytest.mark.parametrize(
    "vector",
    load_vectors(_VECTORS),
    ids=lambda v: v["id"],
)
def test_reference_harness_conformance(vector: dict) -> None:
    result = asyncio.run(run_vector(ReferenceHarness(), vector))
    if result.status == "skip":
        assert result.id in EXPECTED_SKIPS, (
            f"unexpected skip: {result.id} ({result.detail}) — update "
            "EXPECTED_SKIPS only with a capability rationale"
        )
        pytest.skip(result.detail)
    assert result.status == "pass", "\n" + "\n".join(f"  - {f}" for f in result.failures)


def test_skip_set_matches_manifest() -> None:
    skipped = set()
    for vector in load_vectors(_VECTORS):
        result = asyncio.run(run_vector(ReferenceHarness(), vector))
        if result.status == "skip":
            skipped.add(result.id)
    assert skipped == set(EXPECTED_SKIPS), (
        "expected-but-not-skipped vectors mean the manifest is stale"
    )


def test_structural_harness_without_setup_declared_fails_the_vector() -> None:
    """A harness that declares host_declaration but lacks the seam fails
    the vector with a stated detail; it must not abort the run."""
    from typing import Any, ClassVar

    from agent_hooks.ctk import Capability, RunRecord, Scenario

    class Structural:
        name = "structural"
        capabilities: ClassVar[frozenset[Capability]] = frozenset(
            {Capability.MODEL_CALLS, Capability.TOOL_CALLS, Capability.HOST_DECLARATION}
        )

        def setup(self, scenario: Scenario, *args: Any, **kwargs: Any) -> None:
            raise AssertionError("field-based setup must not be used for a declaration vector")

        async def run(self) -> RunRecord:
            raise AssertionError("run must not be reached")

        def teardown(self) -> None:
            pass

    vector = next(v for v in load_vectors(_VECTORS) if v["id"] == "AH-CTK-120")
    result = asyncio.run(run_vector(Structural(), vector))  # type: ignore[arg-type]
    assert result.status == "fail"
    assert any("does not implement setup_declared" in f for f in result.failures)


def test_prove_paths_keeps_a_null_binding_config() -> None:
    """``config: null`` is a stated value; the builder path must rebuild
    it verbatim so the four paths agree."""
    from agent_hooks import HostRegistry, HostSurface
    from agent_hooks.ctk.runner import prove_paths

    reg = HostRegistry(HostSurface.from_capabilities(["host_declaration"])).kind(
        "com.example.x",
        lambda _c, _x: None,  # type: ignore[arg-type,return-value]
    )
    doc = {
        "declaration": "agent-hooks-declaration/1.0",
        "bindings": [{"id": "a", "kind": "com.example.x", "config": None}],
    }
    assert prove_paths(doc, reg, "test") == (True, "")
