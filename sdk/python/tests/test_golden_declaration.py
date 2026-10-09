# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""``conformance/golden/declaration.json``: documents with their
resolved canonical JSON against a fixed surface, asserted byte for
byte in every SDK (§7.7.3 "Resolved form", §7.7.7)."""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest
from agent_hooks import (
    HostDeclaration,
    HostRegistry,
    HostSurface,
    InterceptionPoint,
    KnobSupport,
    _core,
)
from agent_hooks._marshal import dumps
from agent_hooks.composition import CompositionProfile
from agent_hooks.context import AgentContext

_GOLDEN = json.loads(
    (
        pathlib.Path(__file__).resolve().parents[3] / "conformance" / "golden" / "declaration.json"
    ).read_text(encoding="utf-8")
)


def _surface() -> HostSurface:
    """The fixed surface as this SDK's type, so the fixture also pins
    :meth:`HostSurface.to_wire`."""
    s = _GOLDEN["surface"]
    assert s["interceptor_timeout"] == "bounded"
    return HostSurface(
        interception_points=frozenset(InterceptionPoint(p) for p in s["interception_points"]),
        capabilities=frozenset(s["capabilities"]),
        profiles={
            CompositionProfile(p): KnobSupport.from_wire(k) for p, k in s["profiles"].items()
        },
        tool_seam_host_error=s["tool_seam_host_error"],
        streams_unbuffered=s["streams_unbuffered"],
        exposure_bound=s.get("exposure_bound"),
        declaration_versions=frozenset(s["declaration_versions"]),
    )


class _Allow:
    def intercept(self, _ctx: AgentContext) -> dict[str, Any]:
        return {"decision": "allow"}


def _registry() -> HostRegistry:
    names = _GOLDEN["names"]
    reg = HostRegistry(_surface())
    for kind in names["kinds"]:
        reg.kind(kind, lambda _c, _x: _Allow())
    for name in names["identity_providers"]:
        reg.identity_provider(name, lambda _c: "mac")
    for name in names["approval_resolvers"]:
        reg.approval_resolver(name, object())  # type: ignore[arg-type]
    for name in names["approval_redactors"]:
        reg.approval_redactor(name, lambda c: c)
    return reg


def test_surface_wire_matches_the_fixture() -> None:
    assert _surface().to_wire() == _GOLDEN["surface"]
    assert _registry().names() == _GOLDEN["names"]


@pytest.mark.parametrize("fixture", _GOLDEN["fixtures"], ids=lambda f: f["id"])
def test_golden_declarations_resolve_byte_for_byte(fixture: dict[str, Any]) -> None:
    # Straight through the core, as the FFI sees it.
    host = dumps({"surface": _GOLDEN["surface"], **_GOLDEN["names"]})
    resolved = _core.declaration_resolve(dumps(fixture["document"]), host)
    assert _core.canonical_json(resolved) == fixture["expect"]["canonical_json"]
    # Through this SDK's types.
    decl = HostDeclaration.from_value(fixture["document"])
    assert _registry().resolve(decl).canonical_json() == fixture["expect"]["canonical_json"]


def test_every_profile_has_full_knob_support_in_the_fixture() -> None:
    for p in CompositionProfile:
        assert _surface().profiles[p] == KnobSupport.full(p)
