# Copyright (c) Microsoft. All rights reserved.

"""CTK self-test: the vectors against the in-tree ReferenceHarness. The
gating run is under 0.1, the newest released version: the released set
runs and the draft-only vectors (``introduced_in: draft``) are skipped.
The ``draft``-marked test runs those under the draft in the advisory
job. Binding tests to a draft revision is #188."""

from __future__ import annotations

import asyncio
import pathlib

import pytest
from agent_hooks import SPEC_VERSION_0_1, SPEC_VERSION_DRAFT
from agent_hooks.ctk import (
    DRAFT_NOT_CLAIMABLE,
    conformance_report,
    load_vectors,
    run_vector,
)
from agent_hooks.ctk.reference import REFERENCE_DECLARATION, ReferenceHarness

_CONFORMANCE = pathlib.Path(__file__).resolve().parents[3] / "conformance"
_VECTORS = _CONFORMANCE / "0.1" / "vectors"

# Pinned capability skips: Python ints are arbitrary precision, so the
# reference harness declares every value-domain capability and no
# value-domain vector may skip. The streaming/incremental part (§12.1
# exception) skips because the reference harness buffers caller-bound
# output and does not declare incremental_output. The declaration/*
# parts (§7.7.9) run: the harness declares host_declaration and builds
# every emitter through the loader. Any other skip means a capability
# regressed or a vector was quietly excluded; both must fail the suite.
CAPABILITY_SKIPS: frozenset[str] = frozenset(
    {"AH-CTK-110", "AH-CTK-111", "AH-CTK-112", "AH-CTK-113"}
)
EXPECTED_SKIPS: frozenset[str] = CAPABILITY_SKIPS


def test_reference_declaration_uses_released_specification() -> None:
    assert REFERENCE_DECLARATION["spec"] == SPEC_VERSION_0_1
    assert REFERENCE_DECLARATION["declaration"] == "agent-hooks-declaration/1.0"
    assert REFERENCE_DECLARATION["surface"]["declaration_versions"] == [
        "agent-hooks-declaration/1.0"
    ]


def test_packaged_vectors_match_released_suite() -> None:
    assert load_vectors() == load_vectors(_VECTORS)


@pytest.mark.parametrize(
    "vector",
    load_vectors(_VECTORS),
    ids=lambda v: v["id"],
)
def test_reference_harness_conformance(vector: dict) -> None:
    result = asyncio.run(run_vector(ReferenceHarness(SPEC_VERSION_0_1), vector))
    if result.status == "skip":
        assert result.id in EXPECTED_SKIPS, (
            f"unexpected skip: {result.id} ({result.detail}) — update "
            "CAPABILITY_SKIPS only with a capability rationale"
        )
        pytest.skip(result.detail)
    assert result.status == "pass", "\n" + "\n".join(f"  - {f}" for f in result.failures)


def test_skip_set_matches_manifest() -> None:
    skipped = set()
    for vector in load_vectors(_VECTORS):
        result = asyncio.run(run_vector(ReferenceHarness(SPEC_VERSION_0_1), vector))
        if result.status == "skip":
            skipped.add(result.id)
    assert skipped == set(EXPECTED_SKIPS), (
        "expected-but-not-skipped vectors mean the manifest is stale"
    )
    assert not any(v.get("introduced_in") == "draft" for v in load_vectors(_VECTORS))


@pytest.mark.draft
def test_draft_only_vectors_pass_under_the_draft() -> None:
    """Advisory (the draft-tests job): the working test set for the next
    version passes under the draft."""
    released_ids = {v["id"] for v in load_vectors(_VECTORS)}
    draft = [
        v for v in load_vectors(_CONFORMANCE / "draft" / "vectors") if v["id"] not in released_ids
    ]
    assert len(draft) == 14
    failures = []
    for vector in draft:
        result = asyncio.run(run_vector(ReferenceHarness(SPEC_VERSION_DRAFT), vector))
        if result.status != "pass":
            failures.append(f"{result.id}: {result.status} {result.detail} {result.failures}")
    assert not failures, "\n".join(failures)


def test_a_harness_names_its_version() -> None:
    """The runner refuses a harness that does not say which version it
    builds under; there is no default."""
    from typing import Any, ClassVar

    from agent_hooks.ctk import Capability

    class Nameless:
        name = "nameless"
        capabilities: ClassVar[frozenset[Capability]] = frozenset()

        def setup(self, *args: Any, **kwargs: Any) -> None:
            raise AssertionError("setup must not be reached")

        async def run(self) -> Any:
            raise AssertionError("run must not be reached")

        def teardown(self) -> None:
            pass

    vector = next(v for v in load_vectors(_VECTORS) if v["id"] == "AH-CTK-001")
    with pytest.raises(ValueError, match="spec must name the specification version"):
        asyncio.run(run_vector(Nameless(), vector))  # type: ignore[arg-type]


def test_a_report_names_a_released_version_never_the_draft() -> None:
    """Running the working test set is development; the report a claim
    attaches names a released version, and the runner refuses the draft."""
    results = [
        asyncio.run(run_vector(ReferenceHarness(SPEC_VERSION_0_1), v))
        for v in load_vectors(_VECTORS)
    ]
    with pytest.raises(ValueError, match="cannot name agent-hooks/draft") as refused:
        conformance_report(SPEC_VERSION_DRAFT, results)
    assert str(refused.value) == DRAFT_NOT_CLAIMABLE
    with pytest.raises(ValueError, match="SUPPORTED_SPEC_VERSIONS"):
        conformance_report("agent-hooks/9.9", results)
    report = conformance_report(SPEC_VERSION_0_1, results)
    assert report.spec == SPEC_VERSION_0_1
    assert report.failed == 0
    assert report.skipped == len(EXPECTED_SKIPS)
    assert report.passed + report.skipped == len(results)
    names = [p.part for p in report.parts]
    assert names == sorted(names)
    assert all(p.passed + p.failed + p.skipped == len(p.vectors) for p in report.parts)
    streaming = next(p for p in report.parts if p.part == "streaming/incremental")
    assert streaming.skipped == 4 and {v.id for v in streaming.vectors} == set(CAPABILITY_SKIPS)


def test_structural_harness_without_setup_declared_fails_the_vector() -> None:
    """A harness that declares host_declaration but lacks the seam fails
    the vector with a stated detail; it must not abort the run."""
    from typing import Any, ClassVar

    from agent_hooks.ctk import Capability, RunRecord, Scenario

    class Structural:
        name = "structural"
        spec = SPEC_VERSION_0_1
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


def test_harness_with_an_invalid_surface_fails_the_vector() -> None:
    """A harness whose own surface does not validate (incremental_output
    without an exposure bound, no host_surface override) fails the
    declaration vector with a stated defect instead of aborting the
    run."""
    from typing import Any, ClassVar

    from agent_hooks.ctk import Capability, RunRecord, Scenario

    class BadSurface:
        name = "bad-surface"
        spec = SPEC_VERSION_0_1
        capabilities: ClassVar[frozenset[Capability]] = frozenset(
            {
                Capability.MODEL_CALLS,
                Capability.TOOL_CALLS,
                Capability.INCREMENTAL_OUTPUT,
                Capability.HOST_DECLARATION,
            }
        )

        def setup(self, scenario: Scenario, *args: Any, **kwargs: Any) -> None:
            raise AssertionError("setup must not be reached")

        def setup_declared(self, *args: Any) -> None:
            raise AssertionError("setup_declared must not be reached")

        async def run(self) -> RunRecord:
            raise AssertionError("run must not be reached")

        def teardown(self) -> None:
            pass

    vector = next(v for v in load_vectors(_VECTORS) if v["id"] == "AH-CTK-120")
    result = asyncio.run(run_vector(BadSurface(), vector))  # type: ignore[arg-type]
    assert result.status == "fail"
    assert any("harness defect: host surface rejected" in f for f in result.failures)


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
        "spec": SPEC_VERSION_0_1,
        "bindings": [{"id": "a", "kind": "com.example.x", "config": None}],
    }
    assert prove_paths(doc, reg, "test") == (True, "")
