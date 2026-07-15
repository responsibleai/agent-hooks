# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Cross-SDK golden vectors for §10 canonical JSON and context identity.

Loads ``conformance/golden/identity.json`` (generated from the Rust core)
and asserts the Python SDK — which delegates to the same core via PyO3 —
produces identical output. This is the RM-N01/RM-N02 closure test.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from agent_hooks import canonical_json, context_identity

_GOLDEN = pathlib.Path(__file__).resolve().parents[3] / "conformance" / "golden" / "identity.json"
_FIXTURES = json.loads(_GOLDEN.read_text())["fixtures"]


@pytest.mark.parametrize("f", _FIXTURES, ids=[f["id"] for f in _FIXTURES])
def test_golden_canonical_json(f: dict) -> None:
    if "error" in f["expect"]:
        pytest.skip("negative fixture: canonicalization asserted via identity")
    assert canonical_json(f["ctx"]) == f["expect"]["canonical_json"]


@pytest.mark.parametrize("f", _FIXTURES, ids=[f["id"] for f in _FIXTURES])
def test_golden_context_identity(f: dict) -> None:
    if "error" in f["expect"]:
        # Out-of-domain context: the jcs-sha256 provider MUST reject,
        # never produce a real-looking identity (§10.2).
        with pytest.raises(Exception, match="context_invalid"):
            context_identity(f["ctx"])
        return
    assert context_identity(f["ctx"]) == f["expect"]["context_identity"]


def test_golden_l2_l3_stripped() -> None:
    by_id = {f["id"]: f for f in _FIXTURES}
    assert (
        by_id["G-05-l2-l3-stripped"]["expect"]["context_identity"]
        == by_id["G-05b-l2-l3-baseline"]["expect"]["context_identity"]
    )
