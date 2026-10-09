# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Host declaration document (§7.7): the file path, construction-path
equivalence at the record level, sealing, per-point bindings, the
stamp rule, every refusal class and the registry's own refusals.

Mirrors ``sdk/rust/core/tests/declaration.rs``: the Python wrapper
owns step 1 (read) and step 11 (kind resolvers); steps 2 to 10 are
the core's, reached through ``_core.declaration_resolve``.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
from typing import Any

import pytest
from agent_hooks import (
    DECLARATION_VERSION,
    SPEC_VERSION,
    SUPPORTED_DECLARATION_VERSIONS,
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolution,
    BindingContext,
    CompositionConfig,
    CompositionProfile,
    DeclarationError,
    DeclarationErrorClass,
    EmitterSealed,
    EnforcementMode,
    HostDeclaration,
    HostRegistry,
    HostSurface,
    InterceptionEmitter,
    InterceptionPoint,
    KnobSupport,
    SynthesisPolicy,
    Verdict,
    _core,
)
from agent_hooks.context import AgentContext, AgentContextBuilder
from agent_hooks.declaration import MAX_DOCUMENT_BYTES, valid_kind, valid_reference

FIXED_TIME = "2026-10-09T00:00:00.000Z"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    # Records carry ctx.timestamp; equivalence compares records byte for
    # byte, so the builder's clock is pinned.
    monkeypatch.setattr("agent_hooks.context._now", lambda: FIXED_TIME)


class Scripted:
    def __init__(self, verdict: Verdict) -> None:
        self.verdict = verdict

    def intercept(self, _ctx: AgentContext) -> Verdict:
        return self.verdict


class Approver:
    def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
        return ApprovalResolution(
            outcome=ApprovalOutcome.APPROVE,
            context_identity=request.context_identity,
            verdict=Verdict.allow(),
        )


def surface() -> HostSurface:
    return HostSurface.from_capabilities(["model_calls", "tool_calls", "host_declaration"])


def verdict_from(config: Any, _ctx: BindingContext) -> Scripted:
    decision = config.get("decision") if isinstance(config, dict) else None
    if decision == "allow":
        return Scripted(Verdict.allow())
    if decision == "deny":
        return Scripted(Verdict.deny(reason="test:deny"))
    if decision == "escalate":
        return Scripted(Verdict.escalate(reason="test:escalate"))
    if decision is None:
        raise ValueError("config.decision is required")
    raise ValueError(f"unknown decision {decision!r}")


def raises(_config: Any, _ctx: BindingContext) -> Scripted:
    raise RuntimeError("resolver bug")


def registry() -> HostRegistry:
    return (
        HostRegistry(surface())
        .kind("com.example.scripted", verdict_from)
        .kind("com.example.raises", raises)
        .kind("com.example.not-an-interceptor", lambda _c, _x: 42)  # type: ignore[arg-type,return-value]
        .identity_provider("hmac-sha256-k1", lambda ctx: f"mac:{ctx.get('sequence', -1)}")
        .approval_resolver("operator-queue", Approver())
        .approval_redactor("strip-secrets", lambda ctx: ctx)
    )


def document() -> dict[str, Any]:
    return {
        "declaration": DECLARATION_VERSION,
        "id": "test-doc",
        "configuration": {
            "composition": {"profile": "parallel/strictest"},
            "identity_provider": "hmac-sha256-k1",
            "approval": {"resolver": "operator-queue", "redactor": "strip-secrets"},
            "timeouts": {"interceptor_ms": 2500},
            "records": {"max_buffered": 3},
        },
        "bindings": [
            {"id": "a", "kind": "com.example.scripted", "config": {"decision": "allow"}},
            {
                "id": "b",
                "kind": "com.example.scripted",
                "config": {"decision": "escalate"},
                "at": ["pre_tool_call"],
            },
        ],
    }


def run_session(em: InterceptionEmitter) -> list[dict[str, Any]]:
    b = AgentContextBuilder(agent_id="a1", framework="test-host", session_id="s1")

    async def go() -> list[dict[str, Any]]:
        out = []
        for ctx in (
            b.agent_startup(tools_registered=["http_get"]),
            b.input(content="hi", role="user"),
            b.pre_tool_call(call_id="tc-1", name="http_get", args={"url": "https://x"}),
            b.output(content="done"),
            b.agent_shutdown(reason="completed"),
        ):
            out.append((await em.emit_unchecked(ctx)).to_wire())
        return out

    return asyncio.run(go())


def load(doc: Any, reg: HostRegistry | None = None) -> InterceptionEmitter:
    return InterceptionEmitter.from_declaration_value(doc, reg or registry())


def refusal(doc: Any, reg: HostRegistry | None = None) -> DeclarationError:
    with pytest.raises(DeclarationError) as info:
        load(doc, reg)
    return info.value


# ---- constants and paths --------------------------------------------------------


def test_constants_match_the_core() -> None:
    versions = json.loads(_core.declaration_versions())
    assert versions == {
        "current": DECLARATION_VERSION,
        "supported": list(SUPPORTED_DECLARATION_VERSIONS),
    }
    assert DECLARATION_VERSION in SUPPORTED_DECLARATION_VERSIONS
    assert DECLARATION_VERSION != SPEC_VERSION


def test_three_paths_produce_identical_records(tmp_path: pathlib.Path) -> None:
    reg = registry()
    doc = document()
    text = json.dumps(doc, indent=2)
    path = tmp_path / "doc.json"
    path.write_text(text, encoding="utf-8")

    from_value = InterceptionEmitter.from_declaration_value(doc, reg)
    from_json = InterceptionEmitter.from_declaration_json(text, reg)
    from_path = InterceptionEmitter.from_declaration_path(path, reg)
    built = (
        HostDeclaration.builder()
        .id("test-doc")
        .composition(CompositionConfig.strictest(SynthesisPolicy.DENY))
        .identity_provider("hmac-sha256-k1")
        .approval_resolver("operator-queue")
        .approval_redactor("strip-secrets")
        .interceptor_timeout_ms(2500)
        .max_buffered_records(3)
        .bind("a", "com.example.scripted", {"decision": "allow"})
        .bind(
            "b",
            "com.example.scripted",
            {"decision": "escalate"},
            at=[InterceptionPoint.PRE_TOOL_CALL],
        )
        .build()
    )
    from_code = InterceptionEmitter.from_declaration(built, reg)

    assert from_value.declaration is not None
    canon = from_value.declaration.canonical_json()
    for em in (from_json, from_path, from_code):
        assert em.declaration is not None
        assert em.declaration.canonical_json() == canon
    assert '"on_transform_conflict":"deny"' in canon
    assert "$schema" not in canon

    a = run_session(from_value)
    assert run_session(from_json) == a
    assert run_session(from_path) == a
    assert run_session(from_code) == a

    # Record stamping (§7.7.8).
    for r in a:
        assert r["declaration"] == DECLARATION_VERSION
        assert r["identity_provider"] == "hmac-sha256-k1"
        assert r["composition"] == {
            "profile": "parallel/strictest",
            "on_transform_conflict": "deny",
        }
    # Per-point bindings: `b` runs at pre_tool_call only.
    assert a[0]["interceptors_registered"] == 1
    assert a[0]["verdicts"][0]["name"] == "a"
    assert a[2]["interceptors_registered"] == 2
    assert a[2]["verdicts"][1]["name"] == "b"
    assert a[2]["verdicts"][1]["decision"] == "deny"
    # The liftable deny was consulted through the referenced resolver.
    assert a[2]["resolved_by"] == "approval"
    assert a[2]["verdict"]["decision"] == "allow"
    # records.max_buffered: 3 bounded the buffer.
    assert len(from_value.results) == 3
    assert from_value.records_dropped == 2


def test_code_path_records_carry_no_declaration() -> None:
    em = InterceptionEmitter()
    em.register(Scripted(Verdict.allow()))
    records = run_session(em)
    for r in records:
        assert "declaration" not in r
        assert "name" not in r["verdicts"][0]
    assert em.declaration is None
    assert records[2]["interceptors_registered"] == 1
    assert records[2]["verdict"]["decision"] == "allow"


def test_register_at_filters_points_and_names_verdicts() -> None:
    em = InterceptionEmitter()
    em.register(Scripted(Verdict.deny(reason="x:deny")), name="gate", at=["pre_tool_call"])
    em.register(Scripted(Verdict.allow()), name="audit")
    records = run_session(em)
    startup = records[0]
    assert startup["interceptors_registered"] == 1
    assert startup["verdicts"][0]["name"] == "audit"
    assert startup["verdict"]["decision"] == "allow"
    tool = records[2]
    assert tool["interceptors_registered"] == 2
    assert tool["decided_by"] == 0
    assert tool["verdicts"][0]["name"] == "gate"
    assert tool["verdict"]["decision"] == "deny"
    assert tool["fold_truncated"] is True


def test_register_refuses_an_empty_at() -> None:
    # The declaration path refuses an empty ``at`` as invalid_field; the
    # code path must not register an interceptor that never runs.
    em = InterceptionEmitter()
    with pytest.raises(ValueError, match="at least one interception point"):
        em.register(Scripted(Verdict.allow()), at=[])
    assert em._interceptors == []


def test_point_without_binding_denies_no_interceptor() -> None:
    em = load(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [
                {
                    "id": "a",
                    "kind": "com.example.scripted",
                    "config": {"decision": "allow"},
                    "at": ["pre_tool_call"],
                }
            ],
        }
    )
    records = run_session(em)
    assert records[0]["verdict"]["reason"] == "host_error:no_interceptor"
    assert records[0]["interceptors_registered"] == 0
    assert records[0]["declaration"] == DECLARATION_VERSION
    assert records[2]["verdict"]["decision"] == "allow"
    assert records[2]["interceptors_registered"] == 1


def test_minimal_document_resolves_to_spec_defaults() -> None:
    em = load(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [
                {"id": "allow", "kind": "com.example.scripted", "config": {"decision": "allow"}}
            ],
        }
    )
    r = em.declaration
    assert r is not None
    assert r.version == DECLARATION_VERSION
    assert r.spec == SPEC_VERSION
    assert r.mode is EnforcementMode.ENFORCE
    assert r.composition == CompositionConfig.default()
    assert r.identity_provider == "jcs-sha256"
    assert r.configuration["approval"] == {"resolver": None, "redactor": None}
    assert r.configuration["posture"] == {"tool_seam_host_error": "continue"}
    assert r.configuration["timeouts"] == {"interceptor_ms": 5000, "approval_resolver_ms": 5000}
    assert r.configuration["records"] == {"max_buffered": None}
    assert len(r.surface["interception_points"]) == 8
    assert r.surface["buffered_output"] is True
    (binding,) = r.bindings
    assert binding.at == frozenset(InterceptionPoint)
    assert binding.timeout_ms == 5000
    assert binding.config == {"decision": "allow"}
    assert em.mode is EnforcementMode.ENFORCE
    assert em.composition == CompositionConfig.default()


# ---- sealing ---------------------------------------------------------------------


def test_sealed_emitter_refuses_reconfiguration() -> None:
    em = load(document())
    # Allowed after sealing: where records go, not what they say.
    em.set_record_sink(lambda _r: None)
    assert em.take_records() == []
    with pytest.raises(EmitterSealed, match="register"):
        em.register(Scripted(Verdict.allow()))
    with pytest.raises(EmitterSealed, match="set_composition"):
        em.set_composition(CompositionConfig.default())
    with pytest.raises(EmitterSealed, match="set_identity_provider"):
        em.set_identity_provider(None)
    with pytest.raises(EmitterSealed, match="set_approval_redactor"):
        em.set_approval_redactor(lambda ctx: ctx)
    with pytest.raises(EmitterSealed, match="set_max_records"):
        em.set_max_records(1)
    # The constructor path is not sealed.
    InterceptionEmitter().register(Scripted(Verdict.allow())).set_max_records(1)


# ---- refusal classes -------------------------------------------------------------


def test_binding_rejected_by_raise_and_by_non_interceptor() -> None:
    e = refusal(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [
                {"id": "ok", "kind": "com.example.scripted", "config": {"decision": "allow"}},
                {
                    "id": "bad",
                    "kind": "com.example.scripted",
                    "config": {"decision": "maybe", "secret": "hunter2"},
                },
            ],
        }
    )
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert e.code == "declaration_error:binding_rejected"
    assert e.findings[0].pointer == "/bindings/1"
    assert '"bad"' in e.findings[0].detail
    assert "com.example.scripted" in e.findings[0].detail
    assert "hunter2" not in str(e)

    e = refusal(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [{"id": "boom", "kind": "com.example.raises"}],
        }
    )
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert "resolver bug" in e.findings[0].detail

    e = refusal(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [{"id": "n", "kind": "com.example.not-an-interceptor"}],
        }
    )
    assert e.error_class is DeclarationErrorClass.BINDING_REJECTED
    assert "not an interceptor" in e.findings[0].detail


def test_unreadable_classes_from_path(tmp_path: pathlib.Path) -> None:
    reg = registry()

    def refused(p: pathlib.Path) -> DeclarationError:
        with pytest.raises(DeclarationError) as info:
            InterceptionEmitter.from_declaration_path(p, reg)
        return info.value

    e = refused(tmp_path / "does-not-exist.json")
    assert e.error_class is DeclarationErrorClass.UNREADABLE
    assert "NotFound" in e.findings[0].detail
    e = refused(tmp_path)
    assert e.error_class is DeclarationErrorClass.UNREADABLE
    assert "regular file" in e.findings[0].detail
    if hasattr(os, "mkfifo"):
        # Opened without blocking and refused on the open descriptor,
        # so a swap between the type check and the read cannot hang
        # the loader.
        fifo = tmp_path / "fifo.json"
        os.mkfifo(fifo)
        e = refused(fifo)
        assert e.error_class is DeclarationErrorClass.UNREADABLE
        assert "regular file" in e.findings[0].detail
    big = tmp_path / "big.json"
    big.write_bytes(b" " * (MAX_DOCUMENT_BYTES + 1))
    e = refused(big)
    assert e.error_class is DeclarationErrorClass.UNREADABLE
    assert "bytes" in e.findings[0].detail
    bad = tmp_path / "utf8.json"
    bad.write_bytes(b"{\xff}")
    e = refused(bad)
    assert e.error_class is DeclarationErrorClass.UNREADABLE
    assert "UTF-8" in e.findings[0].detail
    bom = tmp_path / "bom.json"
    bom.write_bytes(b"\xef\xbb\xbf{}")
    e = refused(bom)
    assert e.error_class is DeclarationErrorClass.UNREADABLE
    assert "byte-order mark" in e.findings[0].detail
    # A readable file with a bad document reaches the later steps.
    text = tmp_path / "v.json"
    text.write_text('{"declaration": "agent-hooks-declaration/0.1", "bindings": []}')
    e = refused(text)
    assert e.error_class is DeclarationErrorClass.VERSION_UNSUPPORTED
    assert e.accepted == (DECLARATION_VERSION,)


def test_malformed_text_and_values() -> None:
    reg = registry()
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json("not json", reg)
    assert info.value.error_class is DeclarationErrorClass.MALFORMED
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json("[]", reg)
    assert info.value.error_class is DeclarationErrorClass.MALFORMED
    # Duplicate keys are refused on text input (§7.7.6).
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json(
            '{"declaration": "agent-hooks-declaration/1.0", "bindings": [], "bindings": []}', reg
        )
    assert info.value.error_class is DeclarationErrorClass.MALFORMED
    # The value path refuses what the wire cannot carry.
    e = refusal(
        {"declaration": DECLARATION_VERSION, "bindings": [], "extensions": {"x": float("nan")}}
    )
    assert e.error_class is DeclarationErrorClass.MALFORMED
    assert "cannot serialize" in e.findings[0].detail
    e = refusal({"declaration": DECLARATION_VERSION, "bindings": [], "extensions": {"x": object()}})
    assert e.error_class is DeclarationErrorClass.MALFORMED
    # json.dumps would coerce a non-string key to text; no JSON text can
    # carry such a value, so the value path refuses it.
    e = refusal(
        {
            "declaration": DECLARATION_VERSION,
            "bindings": [{"id": "a", "kind": "com.example.scripted", "config": {1: "allow"}}],
        }
    )
    assert e.error_class is DeclarationErrorClass.MALFORMED
    assert e.findings[0].pointer == "/bindings/0/config"
    assert "key is not a string" in e.findings[0].detail


def test_non_ascii_document_is_measured_in_utf8_on_every_path(tmp_path: pathlib.Path) -> None:
    # The 1 MiB bound (§7.7.3) is a byte count on the UTF-8 text. A
    # value serialized with ``\\uXXXX`` escapes would be three times as
    # wide for this content and refused on the value path alone.
    base = {"declaration": DECLARATION_VERSION, "bindings": [], "extensions": {"x": ""}}
    room = MAX_DOCUMENT_BYTES - len(json.dumps(base, separators=(",", ":")).encode("utf-8"))
    doc = {**base, "extensions": {"x": "\u00e9" * (room // 2)}}
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    assert len(text.encode("utf-8")) <= MAX_DOCUMENT_BYTES
    assert len(json.dumps(doc, separators=(",", ":"))) > MAX_DOCUMENT_BYTES
    path = tmp_path / "wide.json"
    path.write_bytes(text.encode("utf-8"))
    reg = registry()
    canon = reg.resolve(HostDeclaration.from_value(doc)).canonical_json()
    assert reg.resolve(HostDeclaration.from_json(text)).canonical_json() == canon
    assert reg.resolve(HostDeclaration.from_path(path)).canonical_json() == canon
    built = (
        HostDeclaration.builder().raw("bindings", []).extension("x", doc["extensions"]["x"]).build()
    )
    assert reg.resolve(built).canonical_json() == canon
    # One byte over is refused on every path with one class.
    over = {**base, "extensions": {"x": "\u00e9" * (room // 2) + "a" * (room % 2 + 1)}}
    over_text = json.dumps(over, ensure_ascii=False, separators=(",", ":"))
    assert len(over_text.encode("utf-8")) == MAX_DOCUMENT_BYTES + 1
    assert refusal(over).error_class is DeclarationErrorClass.MALFORMED
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json(over_text, reg)
    assert info.value.error_class is DeclarationErrorClass.MALFORMED


def test_lone_surrogate_is_malformed_on_text_and_value_paths() -> None:
    # A Python str can hold a lone surrogate; UTF-8 cannot. The core
    # takes strict UTF-8, so the wrapper refuses before conversion
    # rather than leaking UnicodeEncodeError.
    reg = registry()
    doc = {"declaration": DECLARATION_VERSION, "bindings": [], "extensions": {"x": "\ud800"}}
    e = refusal(doc)
    assert e.error_class is DeclarationErrorClass.MALFORMED
    assert "UTF-8" in e.findings[0].detail
    text = '{"declaration":"agent-hooks-declaration/1.0","bindings":[],"extensions":{"x":"\ud800"}}'
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json(text, reg)
    assert info.value.error_class is DeclarationErrorClass.MALFORMED
    # The escaped spelling reaches the core, which refuses it as the
    # same class.
    escaped = text.replace("\ud800", "\\ud800")
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration_json(escaped, reg)
    assert info.value.error_class is DeclarationErrorClass.MALFORMED


@pytest.mark.parametrize(
    ("doc", "error_class", "pointer"),
    [
        (
            {"declaration": "agent-hooks-declaration/0.1", "bindings": []},
            DeclarationErrorClass.VERSION_UNSUPPORTED,
            "/declaration",
        ),
        ({"bindings": []}, DeclarationErrorClass.VERSION_UNSUPPORTED, "/declaration"),
        (
            {"declaration": "agent-hooks-declaration/1.9", "bindings": []},
            DeclarationErrorClass.VERSION_UNSUPPORTED,
            "/declaration",
        ),
        (
            {"declaration": DECLARATION_VERSION, "spec": "agent-hooks/9.0", "bindings": []},
            DeclarationErrorClass.SPEC_UNSUPPORTED,
            "/spec",
        ),
        (
            {"declaration": DECLARATION_VERSION, "bindings": [], "policy": {}},
            DeclarationErrorClass.UNKNOWN_FIELD,
            "/policy",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {
                    "composition": {"profile": "sequential/run_all", "on_timeout": 1}
                },
            },
            DeclarationErrorClass.UNKNOWN_FIELD,
            "/configuration/composition/on_timeout",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {"mode": "audit"},
            },
            DeclarationErrorClass.INVALID_FIELD,
            "/configuration/mode",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {
                    "composition": {"profile": "sequential/run_all", "on_approval": "resume"}
                },
            },
            DeclarationErrorClass.INCONSISTENT,
            "/configuration/composition/on_approval",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "surface": {
                    "interception_points": [
                        "agent_startup",
                        "input",
                        "pre_model_call",
                        "post_model_call",
                        "pre_tool_call",
                        "post_tool_call",
                        "output",
                    ]
                },
            },
            DeclarationErrorClass.INCONSISTENT,
            "/surface/interception_points",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [
                    {"id": "a", "kind": "com.example.scripted", "config": {"decision": "allow"}},
                    {"id": "a", "kind": "com.example.scripted", "config": {"decision": "allow"}},
                ],
            },
            DeclarationErrorClass.INCONSISTENT,
            "/bindings/1/id",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "surface": {
                    "declaration_versions": [DECLARATION_VERSION, "agent-hooks-declaration/0.1"]
                },
            },
            DeclarationErrorClass.SURFACE_UNSUPPORTED,
            "/surface/declaration_versions",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "surface": {
                    "capabilities": ["host_declaration", "model_calls", "tool_calls", "streaming"]
                },
            },
            DeclarationErrorClass.SURFACE_UNSUPPORTED,
            "/surface/capabilities",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {"posture": {"tool_seam_host_error": "terminate"}},
            },
            DeclarationErrorClass.SURFACE_UNSUPPORTED,
            "/configuration/posture/tool_seam_host_error",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {"identity_provider": "hmac-sha256-k9"},
            },
            DeclarationErrorClass.REFERENCE_UNRESOLVED,
            "/configuration/identity_provider",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [],
                "configuration": {"approval": {"resolver": "nobody"}},
            },
            DeclarationErrorClass.REFERENCE_UNRESOLVED,
            "/configuration/approval/resolver",
        ),
        (
            {
                "declaration": DECLARATION_VERSION,
                "bindings": [{"id": "x", "kind": "com.example.none"}],
            },
            DeclarationErrorClass.KIND_UNKNOWN,
            "/bindings/0/kind",
        ),
    ],
    ids=lambda v: v.value if isinstance(v, DeclarationErrorClass) else None,
)
def test_each_refusal_class_names_its_pointer(
    doc: dict[str, Any], error_class: DeclarationErrorClass, pointer: str
) -> None:
    e = refusal(doc)
    assert e.error_class is error_class
    assert e.code == f"declaration_error:{error_class.value}"
    assert e.findings[0].pointer == pointer
    assert str(e).startswith(e.code)
    if error_class is DeclarationErrorClass.VERSION_UNSUPPORTED:
        assert e.accepted == (DECLARATION_VERSION,)
        assert DECLARATION_VERSION in e.findings[0].detail
    else:
        assert e.accepted == ()


def test_one_class_per_document_in_pipeline_order() -> None:
    # A document breaking steps 3, 5, 6, 7 and 10 at once reports the
    # earliest step only; fixing each in turn walks the pipeline.
    reg = registry()
    doc: dict[str, Any] = {
        "declaration": "agent-hooks-declaration/0.1",
        "policy": {},
        "configuration": {
            "mode": "audit",
            "composition": {"profile": "sequential/run_all", "on_approval": "stop"},
        },
        "bindings": [{"id": "x", "kind": "com.example.none"}],
    }
    assert refusal(doc, reg).error_class is DeclarationErrorClass.VERSION_UNSUPPORTED
    doc["declaration"] = DECLARATION_VERSION
    assert refusal(doc, reg).error_class is DeclarationErrorClass.UNKNOWN_FIELD
    del doc["policy"]
    assert refusal(doc, reg).error_class is DeclarationErrorClass.INVALID_FIELD
    doc["configuration"]["mode"] = "enforce"
    assert refusal(doc, reg).error_class is DeclarationErrorClass.INCONSISTENT
    doc["configuration"]["composition"] = {"profile": "sequential/run_all"}
    assert refusal(doc, reg).error_class is DeclarationErrorClass.KIND_UNKNOWN
    doc["bindings"][0]["kind"] = "com.example.scripted"
    assert refusal(doc, reg).error_class is DeclarationErrorClass.BINDING_REJECTED
    doc["bindings"][0]["config"] = {"decision": "allow"}
    assert load(doc, reg).declaration is not None


def test_builder_is_validated_like_a_file() -> None:
    # The builder writes an unconsulted knob out; the loader refuses it
    # with the class a file gets (§7.7.7), and no emitter exists.
    built = (
        HostDeclaration.builder()
        .composition(
            CompositionConfig(
                profile=CompositionConfig.run_all().profile,
                on_approval=CompositionConfig.default().on_approval,
            )
        )
        .bind("a", "com.example.scripted", {"decision": "allow"})
        .build()
    )
    with pytest.raises(DeclarationError) as info:
        InterceptionEmitter.from_declaration(built, registry())
    assert info.value.error_class is DeclarationErrorClass.INCONSISTENT
    assert info.value.findings[0].pointer == "/configuration/composition/on_approval"
    # The same document as a file gets the same class.
    e = refusal(built.as_value())
    assert e.error_class is DeclarationErrorClass.INCONSISTENT
    # An unknown member set through raw() is unknown_field, as in a file.
    e = refusal(HostDeclaration.builder().raw("policy", {}).to_value())
    assert e.error_class is DeclarationErrorClass.UNKNOWN_FIELD


def test_builder_writes_config_verbatim_including_null() -> None:
    # ``config: null`` is a valid member the core keeps as ``null``; the
    # builder must not collapse it into the default ``{}``, or a file
    # that states it could not be rebuilt (§7.7.7).
    reg = registry()
    doc = {
        "declaration": DECLARATION_VERSION,
        "bindings": [
            {"id": "a", "kind": "com.example.scripted", "config": None},
            {"id": "b", "kind": "com.example.scripted"},
        ],
    }
    built = (
        HostDeclaration.builder()
        .bind("a", "com.example.scripted", None)
        .bind("b", "com.example.scripted")
        .build()
    )
    assert built.as_value()["bindings"][0]["config"] is None
    assert "config" not in built.as_value()["bindings"][1]
    canon = reg.resolve(HostDeclaration.from_value(doc)).canonical_json()
    assert reg.resolve(built).canonical_json() == canon
    resolved = reg.resolve(built)
    assert resolved.bindings[0].config is None
    assert resolved.bindings[1].config == {}


# ---- registry and surface --------------------------------------------------------


def test_registry_refuses_reserved_segments_bad_grammar_and_duplicates() -> None:
    reg = HostRegistry(surface())
    with pytest.raises(ValueError, match="reserved segment"):
        reg.kind("ctk.scripted", verdict_from)
    with pytest.raises(ValueError, match="reserved segment"):
        reg.kind("agent_hooks.allow", verdict_from)
    with pytest.raises(ValueError, match="kind grammar"):
        reg.kind("nodot", verdict_from)
    with pytest.raises(ValueError, match="kind grammar"):
        reg.kind("Com.Example", verdict_from)
    reg.kind("com.example.a", verdict_from)
    with pytest.raises(ValueError, match="registered twice"):
        reg.kind("com.example.a", verdict_from)
    with pytest.raises(ValueError, match="jcs"):
        reg.identity_provider("jcs-sha512", lambda _c: "")
    with pytest.raises(ValueError, match="does not match"):
        reg.approval_resolver("Operator Queue", Approver())
    with pytest.raises(ValueError, match="does not match"):
        reg.approval_redactor("x" * 65, lambda c: c)
    # The conformance kit may use the ctk segment; agent_hooks stays closed.
    HostRegistry.for_conformance(surface()).kind("ctk.scripted", verdict_from)
    with pytest.raises(ValueError, match="reserved segment"):
        HostRegistry.for_conformance(surface()).kind("agent_hooks.x", verdict_from)
    assert HostRegistry(surface()).kind("com.example.a", verdict_from).names() == {
        "identity_providers": [],
        "approval_resolvers": [],
        "approval_redactors": [],
        "kinds": ["com.example.a"],
    }
    assert valid_kind("com.example.egress") and not valid_kind("com") and not valid_kind("a." * 70)
    assert valid_reference("operator-queue") and not valid_reference("1x")


def test_invalid_host_surface_is_a_programming_error() -> None:
    # tool_calls without the tool points breaks the §3.2 pairs: the
    # host described its code wrongly, and that is never a refusal of a
    # document.
    bad = HostSurface(capabilities=frozenset({"tool_calls", "host_declaration"}))
    with pytest.raises(ValueError, match="host surface is invalid"):
        HostRegistry(bad)
    with pytest.raises(ValueError, match="host surface is invalid"):
        HostRegistry(HostSurface.sdk_default().with_capabilities(["telepathy"]))
    # A posture the code implements is honoured: a document stating it
    # resolves, the other posture is surface_unsupported.
    reg = HostRegistry(HostSurface.from_capabilities(["host_declaration"], "terminate")).kind(
        "com.example.scripted", verdict_from
    )
    em = load(
        {
            "declaration": DECLARATION_VERSION,
            "configuration": {"posture": {"tool_seam_host_error": "terminate"}},
            "bindings": [],
        },
        reg,
    )
    assert em.declaration is not None
    assert em.declaration.configuration["posture"]["tool_seam_host_error"] == "terminate"
    e = refusal({"declaration": DECLARATION_VERSION, "bindings": []}, reg)
    assert e.error_class is DeclarationErrorClass.SURFACE_UNSUPPORTED


def test_surface_absent_resolves_to_the_hosts_own_surface() -> None:
    em = load({"declaration": DECLARATION_VERSION, "bindings": []})
    assert em.declaration is not None
    assert em.declaration.surface == {
        "interception_points": [p.value for p in InterceptionPoint],
        "capabilities": ["host_declaration", "model_calls", "tool_calls"],
        "profiles": {p.value: KnobSupport.full(p).to_wire() for p in sorted(CompositionProfile)},
        "buffered_output": True,
        "declaration_versions": [DECLARATION_VERSION],
    }
    # Zero bindings: every emission denies host_error:no_interceptor.
    records = run_session(em)
    assert all(r["verdict"]["reason"] == "host_error:no_interceptor" for r in records)
    assert all(r["declaration"] == DECLARATION_VERSION for r in records)


# ---- timeouts and host failures --------------------------------------------------


def test_declared_timeouts_bound_interceptor_and_resolver() -> None:
    class Slow:
        async def intercept(self, _ctx: AgentContext) -> Verdict:
            await asyncio.sleep(0.5)
            return Verdict.allow()

    class Escalate:
        def intercept(self, _ctx: AgentContext) -> Verdict:
            return Verdict.escalate(reason="x")

    class SlowResolver:
        async def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
            await asyncio.sleep(0.5)
            return ApprovalResolution(
                outcome=ApprovalOutcome.APPROVE,
                context_identity=request.context_identity,
                verdict=Verdict.allow(),
            )

    reg = (
        HostRegistry(surface())
        .kind("com.example.slow", lambda _c, _x: Slow())
        .kind("com.example.escalate", lambda _c, _x: Escalate())
        .approval_resolver("slow-queue", SlowResolver())
    )
    em = load(
        {
            "declaration": DECLARATION_VERSION,
            "configuration": {"timeouts": {"interceptor_ms": 20, "approval_resolver_ms": 20}},
            "bindings": [{"id": "slow", "kind": "com.example.slow"}],
        },
        reg,
    )
    ctx = AgentContextBuilder(agent_id="a", framework="h", session_id="s").input(
        content="hi", role="user"
    )
    r = asyncio.run(em.emit_unchecked(ctx))
    assert r.verdict.reason == "host_error:interceptor_timeout"

    em = load(
        {
            "declaration": DECLARATION_VERSION,
            "configuration": {
                "approval": {"resolver": "slow-queue"},
                "timeouts": {"interceptor_ms": 1000, "approval_resolver_ms": 20},
            },
            "bindings": [{"id": "esc", "kind": "com.example.escalate"}],
        },
        reg,
    )
    ctx = AgentContextBuilder(agent_id="a", framework="h", session_id="s").input(
        content="hi", role="user"
    )
    r = asyncio.run(em.emit_unchecked(ctx))
    assert r.verdict.reason == "host_error:approval_resolver_failed"
    assert r.resolved_by == "rejection"


def test_record_host_failure_stamps_declaration_and_counts_the_point() -> None:
    em = load(document())
    r = em.record_host_failure(InterceptionPoint.PRE_TOOL_CALL, "TypeError", session_id="s")
    assert r.declaration == DECLARATION_VERSION
    assert r.interceptors_registered == 2
    r = em.record_host_failure(InterceptionPoint.INPUT, "TypeError", session_id="s")
    assert r.interceptors_registered == 1
    legacy = InterceptionEmitter().register(Scripted(Verdict.allow()))
    assert legacy.record_host_failure(InterceptionPoint.INPUT).declaration is None


def test_binding_context_carries_the_resolved_facts() -> None:
    seen: list[BindingContext] = []

    def capture(config: Any, ctx: BindingContext) -> Scripted:
        seen.append(ctx)
        return Scripted(Verdict.allow())

    reg = HostRegistry(surface()).kind("com.example.capture", capture)
    load(
        {
            "declaration": DECLARATION_VERSION,
            "host": {"name": "example-runtime", "version": "3.2.0"},
            "configuration": {"timeouts": {"interceptor_ms": 4000}},
            "bindings": [
                {"id": "a", "kind": "com.example.capture", "at": ["output"], "timeout_ms": 2000},
                {"id": "b", "kind": "com.example.capture", "timeout_ms": None},
            ],
        },
        reg,
    )
    assert [c.id for c in seen] == ["a", "b"]
    assert seen[0].at == frozenset({InterceptionPoint.OUTPUT})
    assert seen[0].timeout == 2.0
    assert seen[1].at == frozenset(InterceptionPoint)
    assert seen[1].timeout is None
    assert seen[0].host == {"name": "example-runtime", "version": "3.2.0"}
    assert seen[0].declaration_version == DECLARATION_VERSION
    assert seen[0].kind == "com.example.capture"


def test_mutating_resolver_leaves_the_resolved_declaration_unchanged() -> None:
    doc = {
        "declaration": DECLARATION_VERSION,
        "host": {"name": "example-runtime", "version": "3.2.0"},
        "bindings": [
            {"id": "a", "kind": "com.example.mutates", "config": {"decision": "allow", "t": 1}}
        ],
    }

    def mutates(config: Any, ctx: BindingContext) -> Scripted:
        config.pop("t")
        config["secret"] = "leaked"
        assert ctx.host is not None
        ctx.host["name"] = "rewritten"  # type: ignore[index]
        return Scripted(Verdict.allow())

    reg = HostRegistry(surface()).kind("com.example.mutates", mutates)
    before = reg.resolve(HostDeclaration.from_value(doc)).canonical_json()
    em = load(doc, reg)
    assert em.declaration is not None
    assert em.declaration.canonical_json() == before
    assert "leaked" not in before
    assert em.declaration.bindings[0].config == {"decision": "allow", "t": 1}
    assert em.declaration.host == {"name": "example-runtime", "version": "3.2.0"}
