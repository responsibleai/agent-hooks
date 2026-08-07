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
# output and does not declare incremental_output. Any other skip means
# a capability regressed or a vector was quietly excluded; both must
# fail the suite.
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
