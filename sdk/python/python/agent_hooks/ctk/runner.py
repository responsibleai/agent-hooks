# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""CTK runner: load vectors, drive a harness, assert ``expect``.

The assertion engine, capability skip check, and scripted
interceptor/resolver evaluation live in the Rust core
(``_core.ctk_*``). This module keeps only:

- vector file globbing (filesystem access stays per-language),
- the orchestration loop that calls ``harness.setup/run/teardown``
  (native callbacks into the framework under test),
- the host declaration seam (§7.7.9): the CTK registry, the proof that
  the value, JSON, file and builder construction paths agree, and the
  ``load`` outcome,
- ``RunRecord`` → wire-JSON marshalling for the core.

Every other language SDK's runner has the same shape.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pathlib
import tempfile
from dataclasses import dataclass, field
from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps
from agent_hooks._types import EnforcementMode, InterceptionPoint
from agent_hooks.composition import CompositionConfig, CompositionProfile
from agent_hooks.context import AgentContext
from agent_hooks.ctk.harness import Harness, LoadRecord, RunOutcome, RunRecord, Scenario
from agent_hooks.ctk.scripted import (
    RecordingInterceptor,
    ScriptedInterceptor,
    ScriptedResolver,
    redact_paths,
)
from agent_hooks.declaration import (
    BindingContext,
    DeclarationBuilder,
    DeclarationError,
    HostDeclaration,
    HostRegistry,
    HostSurface,
    KnobSupport,
)


@dataclass(slots=True)
class VectorResult:
    id: str
    title: str
    status: str  # "pass" | "fail" | "skip"
    detail: str = ""
    failures: list[str] = field(default_factory=list)


def load_vectors(directory: str | pathlib.Path | None = None) -> list[dict[str, Any]]:
    """Load CTK vectors; default = the set vendored inside the wheel.

    Raises rather than returning an empty list: a runner fed zero
    vectors reports 100% pass — a false conformance signal (§13.2).
    """
    if directory is None:
        from importlib.resources import files

        root = files("agent_hooks.ctk") / "vectors"
        vectors = [
            json.loads(f.read_text(encoding="utf-8"))
            for f in sorted(root.iterdir(), key=lambda f: f.name)
            if f.name.startswith("AH-CTK-") and f.name.endswith(".json")
        ]
    else:
        d = pathlib.Path(directory)
        vectors = [
            json.loads(f.read_text(encoding="utf-8")) for f in sorted(d.glob("AH-CTK-*.json"))
        ]
    if not vectors:
        raise FileNotFoundError(
            f"no AH-CTK-*.json vectors found in {directory or 'the packaged set'} — "
            "an empty vector set would report vacuous conformance"
        )
    return vectors


def _run_record_to_wire(rr: RunRecord, postures: dict[str, str]) -> str:
    wire: dict[str, Any] = {
        "outcome": rr.outcome.value,
        "final_output": rr.final_output,
        "tool_invocations": rr.tool_invocations,
        "error": rr.error,
        "identities": [{"input_identity": i, "enforced_identity": e} for i, e in rr.identities],
        "records": rr.records,
        # Harness *declarations* (§13.1), not observed behavior: the
        # engine selects expect.run_outcome_by_posture entries by them.
        "postures": postures,
    }
    if rr.load is not None:
        wire["load"] = rr.load.to_wire()
    return dumps(wire)


# ---- host declaration seam (§7.7.9) -------------------------------------------


class _Scripts:
    """The scripted interceptors and resolver a vector carries, shared
    by the field-based and the declaration path."""

    def __init__(self, vector: dict[str, Any]) -> None:
        # Multi-interceptor vectors (§7.4 fold-through) use
        # interceptor_scripts; single-interceptor vectors use
        # interceptor_script. An empty interceptor_scripts registers
        # zero interceptors (§7 fail-closed vector).
        scripts = vector.get("interceptor_scripts")
        if scripts is None:
            scripts = [vector["interceptor_script"]]
        self.scripts: list[list[dict[str, Any]]] = [list(s) for s in scripts]
        self.approval: list[dict[str, Any]] = list(vector.get("approval_script") or [])
        self.redact: list[str] = list(vector.get("redact_for_approval") or [])
        # Only script 0 records: expect.interceptions describes each
        # emission as the first-registered interceptor saw it. One list
        # is shared, so every binding of script 0 records into it.
        self.recorded: list[AgentContext] = []

    def interceptor(self, i: int) -> ScriptedInterceptor | RecordingInterceptor:
        inner = ScriptedInterceptor(self.scripts[i])
        if i != 0:
            return inner
        return RecordingInterceptor(inner, recorded=self.recorded)

    def interceptors(self) -> list[Any]:
        return [self.interceptor(i) for i in range(len(self.scripts))]

    def resolver(self) -> ScriptedResolver | None:
        return ScriptedResolver(self.approval) if self.approval else None

    def registry(self, surface: HostSurface) -> HostRegistry:
        """The CTK registry for a declaration vector (§7.7.9): kind
        ``ctk.scripted`` (config ``{"script": i}``), identity provider
        ``ctk-fault``, approval resolver ``ctk-scripted``, redactor
        ``ctk-redact``."""

        def scripted(config: Any, ctx: BindingContext) -> Any:
            i = config.get("script") if isinstance(config, dict) else None
            if not isinstance(i, int) or isinstance(i, bool) or i < 0:
                raise ValueError("config.script must be an unsigned integer index")
            if i >= len(self.scripts):
                raise ValueError(f"config.script {i} is out of range for binding {ctx.id}")
            return self.interceptor(i)

        def fault(_ctx: AgentContext) -> str:
            raise RuntimeError("ctk scripted provider fault")

        redact = list(self.redact)
        return (
            HostRegistry.for_conformance(surface)
            .kind("ctk.scripted", scripted)
            .identity_provider("ctk-fault", fault)
            .approval_resolver("ctk-scripted", ScriptedResolver(self.approval))
            .approval_redactor("ctk-redact", lambda ctx: redact_paths(ctx, redact))
        )


def _profile(name: str) -> CompositionProfile | None:
    try:
        return CompositionProfile(name)
    except ValueError:
        return None


def _points(v: Any) -> list[InterceptionPoint] | None:
    if not isinstance(v, list):
        return None
    out = []
    for p in v:
        try:
            out.append(InterceptionPoint(p))
        except ValueError:
            return None
    return out


def _strings(v: Any) -> list[str] | None:
    if not isinstance(v, list) or not all(isinstance(s, str) for s in v):
        return None
    return list(v)


def _is_uint(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _typed_configuration(b: DeclarationBuilder, c: dict[str, Any]) -> bool:
    """Apply a ``configuration`` object through the typed setters;
    ``False`` when some member cannot be expressed exactly."""
    for k, v in c.items():
        if k == "mode" and v in ("enforce", "evaluate_only"):
            b.mode(v)
        elif k == "composition" and isinstance(v, dict):
            known = {"profile", "on_approval", "on_disagreement", "on_transform_conflict"}
            if (
                "profile" not in v
                or not set(v) <= known
                or not all(isinstance(x, str) for x in v.values())
            ):
                return False
            try:
                cfg = CompositionConfig.from_wire(v)
            except ValueError:
                return False
            b.composition(cfg)
        elif k == "identity_provider" and (v is None or isinstance(v, str)):
            b.identity_provider(v)
        elif k == "approval" and isinstance(v, dict):
            for ak, av in v.items():
                if av is not None and not isinstance(av, str):
                    return False
                if ak == "resolver":
                    b.approval_resolver(av)
                elif ak == "redactor":
                    b.approval_redactor(av)
                else:
                    return False
        elif k == "posture" and isinstance(v, dict):
            if set(v) != {"tool_seam_host_error"} or v["tool_seam_host_error"] not in (
                "continue",
                "terminate",
            ):
                return False
            b.tool_seam_host_error(v["tool_seam_host_error"])
        elif k == "timeouts" and isinstance(v, dict):
            for tk, tv in v.items():
                if tv is not None and not _is_uint(tv):
                    return False
                if tk == "interceptor_ms":
                    b.interceptor_timeout_ms(tv)
                elif tk == "approval_resolver_ms":
                    b.approval_resolver_timeout_ms(tv)
                else:
                    return False
        elif k == "records" and isinstance(v, dict):
            if set(v) != {"max_buffered"}:
                return False
            n = v["max_buffered"]
            if n is not None and not _is_uint(n):
                return False
            b.max_buffered_records(n)
        else:
            return False
    return True


def _typed_surface(b: DeclarationBuilder, sf: dict[str, Any]) -> bool:
    bound = sf.get("exposure_bound")
    if "exposure_bound" in sf and not isinstance(bound, str):
        return False
    if "buffered_output" in sf:
        buffered = sf["buffered_output"]
        if not isinstance(buffered, bool):
            return False
        b.buffered_output(buffered, bound)
    elif "exposure_bound" in sf:
        return False
    for k, v in sf.items():
        if k == "interception_points":
            pts = _points(v)
            if pts is None:
                return False
            b.surface_points(pts)
        elif k == "capabilities":
            caps = _strings(v)
            if caps is None:
                return False
            b.surface_capabilities(caps)
        elif k == "declaration_versions":
            vs = _strings(v)
            if vs is None:
                return False
            b.surface_declaration_versions(vs)
        elif k == "profiles":
            if not isinstance(v, dict):
                return False
            for name, knobs in v.items():
                profile = _profile(name)
                if profile is None or not isinstance(knobs, dict):
                    return False
                if not all(_strings(x) is not None for x in knobs.values()) or not set(knobs) <= {
                    "on_approval",
                    "on_disagreement",
                    "on_transform_conflict",
                }:
                    return False
                b.surface_profile(profile, KnobSupport.from_wire(knobs))
        elif k in ("buffered_output", "exposure_bound"):
            continue
        else:
            return False
    return True


def _typed_bindings(b: DeclarationBuilder, items: list[Any]) -> bool:
    known = {"id", "kind", "config", "at", "timeout_ms"}
    if not items:
        # The written-down empty-deny host (§7.7.5): ``bind`` is never
        # called, so the member is set explicitly.
        b.raw("bindings", [])
        return True
    for item in items:
        if not isinstance(item, dict) or not set(item) <= known:
            return False
        if not isinstance(item.get("id"), str) or not isinstance(item.get("kind"), str):
            return False
        at = None
        if "at" in item:
            at = _points(item["at"])
            if at is None:
                return False
        kw: dict[str, Any] = {}
        if "timeout_ms" in item:
            t = item["timeout_ms"]
            if t is not None and not _is_uint(t):
                return False
            kw["timeout_ms"] = t
        b.bind(item["id"], item["kind"], item.get("config", {}), at=at, **kw)
    return True


def builder_from_value(doc: Any) -> DeclarationBuilder:
    """Rebuild a document through :class:`DeclarationBuilder`, member by
    member (§7.7.7, the code path). Members the typed setters cannot
    express exactly (an unknown member, a wrong type) go through
    :meth:`DeclarationBuilder.raw`, so the result is validated like the
    file it came from."""
    b = DeclarationBuilder.empty()
    if not isinstance(doc, dict):
        return b
    for k, v in doc.items():
        if k == "declaration" and isinstance(v, str):
            b.version(v)
        elif k == "spec" and isinstance(v, str):
            b.spec(v)
        elif k == "id" and isinstance(v, str):
            b.id(v)
        elif (
            k == "host"
            and isinstance(v, dict)
            and set(v) <= {"name", "version"}
            and isinstance(v.get("name"), str)
            and (v.get("version") is None or isinstance(v.get("version"), str))
        ):
            b.host(v["name"], v.get("version"))
        elif k == "configuration" and isinstance(v, dict):
            trial = DeclarationBuilder.empty()
            if _typed_configuration(trial, v):
                b.raw("configuration", trial.to_value()["configuration"])
            else:
                b.raw(k, v)
        elif k == "surface" and isinstance(v, dict):
            trial = DeclarationBuilder.empty()
            if _typed_surface(trial, v):
                b.raw("surface", trial.to_value().get("surface", {}))
            else:
                b.raw(k, v)
        elif k == "bindings" and isinstance(v, list):
            trial = DeclarationBuilder.empty()
            if _typed_bindings(trial, v):
                b.raw("bindings", trial.to_value()["bindings"])
            else:
                b.raw(k, v)
        elif k == "extensions" and isinstance(v, dict):
            for ek, ev in v.items():
                b.extension(ek, ev)
        else:
            b.raw(k, v)
    return b


def prove_paths(doc: Any, registry: HostRegistry, tag: str = "vector") -> tuple[bool, str]:
    """Resolve ``doc`` through the four construction paths (§7.7.7) and
    compare: value, JSON text, a temporary file and the builder. Equal
    canonical forms, or equal refusal classes, prove the paths
    equivalent. Returns ``(equivalent, detail)``."""
    text = json.dumps(doc, allow_nan=False, separators=(",", ":"))
    fd, path = tempfile.mkstemp(prefix=f"agent-hooks-ctk-{tag}-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        sources: list[tuple[str, Any]] = [
            ("value", lambda: HostDeclaration.from_value(doc)),
            ("json", lambda: HostDeclaration.from_json(text)),
            ("file", lambda: HostDeclaration.from_path(path)),
            ("builder", lambda: builder_from_value(doc).build()),
        ]
        keys: list[str] = []
        shorts: list[str] = []
        for _name, make in sources:
            try:
                resolved = registry.resolve(make())
            except DeclarationError as e:
                keys.append(f"err:{e.code}")
                shorts.append(str(e))
            else:
                keys.append(f"ok:{resolved.canonical_json()}")
                shorts.append("accepted")
    finally:
        _remove_quietly(path)
    if all(k == keys[0] for k in keys):
        return True, ""
    detail = "".join(f"{name}: {short}; " for (name, _), short in zip(sources, shorts, strict=True))
    oks = [k for k in keys if k.startswith("ok:")]
    if len(oks) >= 2 and oks[0] != oks[1]:
        pos = next((i for i, (x, y) in enumerate(zip(oks[0], oks[1], strict=False)) if x != y), 0)
        detail += f"first difference at byte {pos}"
    return False, detail


def _remove_quietly(path: str) -> None:
    with contextlib.suppress(OSError):
        os.remove(path)


def _resolve_surface_only(document: dict[str, Any], surface: HostSurface) -> dict[str, Any]:
    """Steps 2 to 8 for a harness's own declaration (§7.7.9): the names
    the document references are taken as registered, so only the
    document and the surface are checked. Returns the resolved form."""
    raw_cfg = document.get("configuration") if isinstance(document, dict) else None
    cfg: dict[str, Any] = raw_cfg if isinstance(raw_cfg, dict) else {}
    approval: dict[str, Any] = cfg["approval"] if isinstance(cfg.get("approval"), dict) else {}
    provider = cfg.get("identity_provider")
    names: dict[str, list[str]] = {
        "identity_providers": [provider]
        if isinstance(provider, str) and provider != "jcs-sha256"
        else [],
        "approval_resolvers": [approval["resolver"]]
        if isinstance(approval.get("resolver"), str)
        else [],
        "approval_redactors": [approval["redactor"]]
        if isinstance(approval.get("redactor"), str)
        else [],
        "kinds": sorted(
            {
                b["kind"]
                for b in (document.get("bindings") or [])
                if isinstance(b, dict) and isinstance(b.get("kind"), str)
            }
        )
        if isinstance(document.get("bindings"), list)
        else [],
    }
    host_json = json.dumps({"surface": surface.to_wire(), **names}, separators=(",", ":"))
    try:
        out = _core.declaration_resolve(
            json.dumps(document, allow_nan=False, separators=(",", ":")), host_json
        )
    except _core.AgentHooksCoreError as e:
        if str(getattr(e, "code", "")).startswith("declaration_error:"):
            raise DeclarationError._from_core(e) from None
        raise
    resolved: dict[str, Any] = json.loads(out)
    return resolved


def _code_surface(harness: Harness) -> HostSurface:
    fn = getattr(harness, "host_surface", None)
    if callable(fn):
        surface: HostSurface = fn()
        return surface
    return HostSurface.from_capabilities(
        sorted(c.value for c in harness.capabilities),
        getattr(harness, "tool_seam_host_error", "continue"),
    )


# ---- the loop -----------------------------------------------------------------


async def run_vector(harness: Harness, vector: dict[str, Any]) -> VectorResult:
    vid, title = vector["id"], vector["title"]
    vector_json = dumps(vector)

    def fail(failures: list[str]) -> VectorResult:
        return VectorResult(vid, title, "fail", failures=failures)

    # §7.7.9: a harness with its own declaration is assessed against the
    # resolved document, so what ran is what a claim cites.
    code_surface = _code_surface(harness)
    own = getattr(harness, "declaration", None)
    document_own = own() if callable(own) else None
    if document_own is not None:
        try:
            resolved_own = _resolve_surface_only(document_own, code_surface)
        except DeclarationError as e:
            return fail([f"harness declaration refused: {e}"])
        caps: list[str] = sorted(resolved_own["surface"]["capabilities"])
        posture: str = resolved_own["configuration"]["posture"]["tool_seam_host_error"]
    else:
        caps = sorted(c.value for c in harness.capabilities)
        # §13.1 posture declaration; getattr keeps structural
        # (non-subclass) Harness implementations working — absent means
        # the spec default.
        posture = getattr(harness, "tool_seam_host_error", "continue")

    skip = json.loads(_core.ctk_should_skip(vector_json, dumps(caps)))
    if skip is not None:
        return VectorResult(vid, title, "skip", detail=skip)

    scenario = Scenario.from_wire(vector["scenario"])
    scripts = _Scripts(vector)
    mode = EnforcementMode(vector.get("mode", "enforce"))
    # §13.2: composition vectors carry the profile/knobs they apply to;
    # absent means the pre-P-003 default (§7.2).
    composition = CompositionConfig.from_wire(vector.get("composition"))
    # §10.1: absent → the default provider; explicit null → unbound.
    identity_provider = vector.get("identity_provider", "jcs-sha256")

    load: LoadRecord | None = None
    if "host_declaration" in vector:
        # §7.7.9: the runner proves the construction paths itself, then
        # hands the document and the CTK registry to the harness.
        document = vector["host_declaration"]
        registry = scripts.registry(code_surface)
        paths_equivalent, path_detail = prove_paths(document, registry, vid)
        try:
            harness.setup_declared(scenario, document, registry)
        except DeclarationError as e:
            harness.teardown()
            rr = RunRecord(outcome=RunOutcome.ERROR, final_output=None, error=str(e))
            load = LoadRecord(
                outcome="refused",
                error_class=e.code,
                paths_equivalent=paths_equivalent,
                detail=str(e) if not path_detail else f"{e}; paths: {path_detail}",
            )
        else:
            try:
                rr = await harness.run()
            except Exception as e:  # noqa: BLE001
                return fail([f"harness.run raised: {e!r}"])
            finally:
                harness.teardown()
            load = LoadRecord(
                outcome="accepted",
                paths_equivalent=paths_equivalent,
                detail=path_detail or None,
            )
    else:
        harness.setup(
            scenario,
            scripts.interceptors(),
            scripts.resolver(),
            mode,
            composition,
            identity_provider,
            list(scripts.redact),
        )
        try:
            rr = await harness.run()
        except Exception as e:  # noqa: BLE001
            return fail([f"harness.run raised: {e!r}"])
        finally:
            harness.teardown()
    rr.load = load

    result = json.loads(
        _core.ctk_assert(
            vector_json,
            dumps(scripts.recorded),
            _run_record_to_wire(rr, {"tool_seam_host_error": posture}),
        )
    )
    return VectorResult(
        id=result["id"],
        title=result["title"],
        status=result["status"],
        detail=result.get("detail", ""),
        failures=result.get("failures", []),
    )


def run_vectors(harness_factory: Any, vectors: list[dict[str, Any]]) -> list[VectorResult]:
    """Run all vectors against a fresh harness instance per vector."""

    async def _go() -> list[VectorResult]:
        out = []
        for v in vectors:
            out.append(await run_vector(harness_factory(), v))
        return out

    return asyncio.run(_go())
