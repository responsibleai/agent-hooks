# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Host declaration document (§7.7): loader, host registry and the
resolved form.

A declaration is one JSON object that fixes a host's configuration
(§7.1, §8, §10.1, §13.1), its declared surface (§13.1) and its
interceptor bindings. It is a versioned contract of its own
(``agent-hooks-declaration/<major>.<minor>``, §7.7.2), separate from
the wire version :data:`~agent_hooks.SPEC_VERSION` and from the
package version.

Loading is a pipeline (§7.7.6). Step 1 (read the file) and step 11 (run
the host's kind resolvers) are this wrapper's; steps 2 to 10 run in the
Rust core behind one call (``_core.declaration_resolve``) against the
host's surface and the names its :class:`HostRegistry` holds, so a
document yields the same refusal class here as in every other SDK.
Refusals are construction errors (:class:`DeclarationError`), never
verdicts: no emitter exists yet, so there is no record to carry a §11
reason.

The entry points are on :class:`~agent_hooks.InterceptionEmitter`:
``from_declaration_path``, ``from_declaration_json``,
``from_declaration_value`` and ``from_declaration`` (a
:class:`HostDeclaration`, usually from :class:`DeclarationBuilder`).
"""

from __future__ import annotations

import copy
import errno
import json
import os
import re
import stat
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Final

from agent_hooks import _core
from agent_hooks._types import (
    DECLARATION_VERSION,
    SUPPORTED_DECLARATION_VERSIONS,
    EnforcementMode,
    InterceptionPoint,
)
from agent_hooks.approval import ApprovalResolver
from agent_hooks.composition import CompositionConfig, CompositionProfile
from agent_hooks.context import AgentContext
from agent_hooks.interceptor import Interceptor

# ---- fixed bounds (§7.7.3) ---------------------------------------------------

#: Largest document the text paths accept, in bytes.
MAX_DOCUMENT_BYTES: Final[int] = 1 << 20
#: Longest binding ``id``, reference name and document ``id``.
MAX_ID_LEN: Final[int] = 64
#: Longest binding ``kind``.
MAX_KIND_LEN: Final[int] = 128
#: Longest ``exposure_bound`` and longest refusal detail.
MAX_DETAIL_LEN: Final[int] = 512

#: The §3.2 lifecycle floor: the smallest declared surface.
FLOOR_POINTS: Final[frozenset[InterceptionPoint]] = frozenset(
    {
        InterceptionPoint.AGENT_STARTUP,
        InterceptionPoint.INPUT,
        InterceptionPoint.OUTPUT,
        InterceptionPoint.AGENT_SHUTDOWN,
    }
)

#: The closed capability vocabulary a surface may name (§13.1,
#: ``conformance/vectors.schema.json``). ``buffered_output`` is a value,
#: not a presence, and travels as the boolean surface member instead.
CAPABILITIES: Final[tuple[str, ...]] = (
    "model_calls",
    "tool_calls",
    "parallel_tool_calls",
    "streaming",
    "multi_turn",
    "int64_json",
    "bigint_json",
    "incremental_output",
    "host_declaration",
)

#: Whether this SDK bounds interceptor and resolver execution (§7).
#: The Python emitter always does (``asyncio.wait_for``), so a numeric
#: timeout in a declaration is always honoured.
INTERCEPTOR_TIMEOUT_SUPPORT: Final[str] = "bounded"

_RESERVED_KIND_SEGMENTS: Final[frozenset[str]] = frozenset({"agent_hooks", "ctk"})
_REFERENCE_RE = re.compile(r"[a-z][a-z0-9_-]{0,63}")
_KIND_SEGMENT_RE = re.compile(r"[a-z][a-z0-9_-]*")
_PROVIDER_RE = re.compile(r"[a-z][a-z0-9_-]*")

#: Knobs each profile consults (§7.2), in the record's member order.
_CONSULTED_KNOBS: Final[dict[CompositionProfile, tuple[str, ...]]] = {
    CompositionProfile.SEQUENTIAL_FIRST_DENY: ("on_approval",),
    CompositionProfile.SEQUENTIAL_RUN_ALL: (),
    CompositionProfile.PARALLEL_STRICTEST: ("on_transform_conflict",),
    CompositionProfile.PARALLEL_UNANIMOUS: ("on_disagreement",),
}
_KNOB_VALUES: Final[dict[str, tuple[str, ...]]] = {
    "on_approval": ("stop", "resume"),
    "on_disagreement": ("deny", "approval"),
    "on_transform_conflict": ("deny", "approval"),
}
_KNOB_DEFAULTS: Final[dict[str, str]] = {
    "on_approval": "stop",
    "on_disagreement": "deny",
    "on_transform_conflict": "deny",
}

_LIFECYCLE: Final[tuple[InterceptionPoint, ...]] = tuple(InterceptionPoint)


def _compact(value: Any) -> str:
    """Compact RFC 8259 JSON, the serialization the value path measures
    the 1 MiB bound against (§7.7.3); ``allow_nan=False`` so a
    non-finite number is refused, never written as a bare literal."""
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def _q(s: str) -> str:
    """Double-quoted, escaped, as the core prints names in findings."""
    return json.dumps(s)


def _truncate(s: str) -> str:
    """Bound a detail at :data:`MAX_DETAIL_LEN` characters, ellipsis
    included, as the core does."""
    if len(s) <= MAX_DETAIL_LEN:
        return s
    return s[: MAX_DETAIL_LEN - 1] + "…"


def _points_sorted(points: Iterable[InterceptionPoint]) -> list[str]:
    """Interception points in §3 lifecycle order, as wire strings."""
    chosen = set(points)
    return [p.value for p in _LIFECYCLE if p in chosen]


def _point(value: InterceptionPoint | str) -> InterceptionPoint:
    return value if isinstance(value, InterceptionPoint) else InterceptionPoint(value)


# ---- errors ------------------------------------------------------------------


class DeclarationErrorClass(str, Enum):
    """The eleven refusal classes (§7.7.6), in pipeline order. The value
    is the bare class name; :attr:`code` is the namespaced wire code."""

    UNREADABLE = "unreadable"
    MALFORMED = "malformed"
    VERSION_UNSUPPORTED = "version_unsupported"
    SPEC_UNSUPPORTED = "spec_unsupported"
    UNKNOWN_FIELD = "unknown_field"
    INVALID_FIELD = "invalid_field"
    INCONSISTENT = "inconsistent"
    SURFACE_UNSUPPORTED = "surface_unsupported"
    REFERENCE_UNRESOLVED = "reference_unresolved"
    KIND_UNKNOWN = "kind_unknown"
    BINDING_REJECTED = "binding_rejected"

    @property
    def code(self) -> str:
        """The namespaced code (``declaration_error:unknown_field``)."""
        return f"declaration_error:{self.value}"

    @classmethod
    def from_code(cls, code: str) -> DeclarationErrorClass:
        """Parse a namespaced code or a bare class name."""
        return cls(code.removeprefix("declaration_error:"))


@dataclass(frozen=True, slots=True)
class Finding:
    """One problem a load step found: a JSON pointer into the document
    (``/bindings/1/kind``; the empty string is the root) and a detail
    that names members, kinds and ids but never binding configuration."""

    pointer: str
    detail: str


class DeclarationError(ValueError):
    """A refused host declaration (§7.7.6).

    Carries one :attr:`error_class`, every :attr:`findings` entry that
    step produced and, for ``version_unsupported``, the
    :attr:`accepted` version set. :attr:`code` is the namespaced wire
    code (``declaration_error:<class>``). Raised before any emitter
    exists; it leaves no record.
    """

    def __init__(
        self,
        error_class: DeclarationErrorClass | str,
        findings: Sequence[Finding] | Finding,
        accepted: Sequence[str] = (),
    ) -> None:
        self.error_class = (
            error_class
            if isinstance(error_class, DeclarationErrorClass)
            else DeclarationErrorClass.from_code(error_class)
        )
        self.findings: tuple[Finding, ...] = (
            (findings,) if isinstance(findings, Finding) else tuple(findings)
        )
        self.accepted: tuple[str, ...] = tuple(accepted)
        parts = [self.code]
        for i, f in enumerate(self.findings):
            sep = ": " if i == 0 else "; "
            parts.append(f"{sep}{f.detail}" if f.pointer == "" else f"{sep}{f.pointer}: {f.detail}")
        super().__init__("".join(parts))

    @property
    def code(self) -> str:
        """``declaration_error:<class>``, the value that crosses the FFI."""
        return self.error_class.code

    @classmethod
    def _from_core(cls, e: Exception) -> DeclarationError:
        """Rebuild from an ``AgentHooksCoreError`` whose ``.code`` is a
        ``declaration_error:*`` string and whose ``.detail`` is the
        core's JSON ``{"findings": [...], "accepted": [...]}``."""
        code = str(getattr(e, "code", ""))
        detail = str(getattr(e, "detail", ""))
        try:
            obj = json.loads(detail)
        except ValueError:
            obj = {}
        findings = [
            Finding(pointer=str(f.get("pointer", "")), detail=str(f.get("detail", "")))
            for f in obj.get("findings", [])
            if isinstance(f, dict)
        ]
        if not findings:
            findings = [Finding(pointer="", detail=detail)]
        return cls(code, findings, [str(a) for a in obj.get("accepted", [])])


def _single(error_class: DeclarationErrorClass, pointer: str, detail: str) -> DeclarationError:
    return DeclarationError(error_class, Finding(pointer=pointer, detail=_truncate(detail)))


# ---- surface -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class KnobSupport:
    """The knob values a host supports for one profile (§13.1 "profiles
    and knob values supported"). Only the knobs the profile consults
    are set; an empty set for a consulted knob is never valid."""

    on_approval: frozenset[str] = frozenset()
    on_disagreement: frozenset[str] = frozenset()
    on_transform_conflict: frozenset[str] = frozenset()

    @classmethod
    def full(cls, profile: CompositionProfile) -> KnobSupport:
        """Every value of every knob the profile consults."""
        return cls(**{knob: frozenset(_KNOB_VALUES[knob]) for knob in _CONSULTED_KNOBS[profile]})

    @classmethod
    def defaults_only(cls, profile: CompositionProfile) -> KnobSupport:
        """The §7.2 default value only, for every knob the profile consults."""
        return cls(
            **{knob: frozenset({_KNOB_DEFAULTS[knob]}) for knob in _CONSULTED_KNOBS[profile]}
        )

    def to_wire(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for knob in ("on_approval", "on_disagreement", "on_transform_conflict"):
            values: frozenset[str] = getattr(self, knob)
            if values:
                out[knob] = sorted(values)
        return out

    @classmethod
    def from_wire(cls, obj: Mapping[str, Any]) -> KnobSupport:
        return cls(**{k: frozenset(v) for k, v in obj.items()})


def _all_profiles_full() -> dict[CompositionProfile, KnobSupport]:
    return {p: KnobSupport.full(p) for p in CompositionProfile}


@dataclass(frozen=True, slots=True)
class HostSurface:
    """What the host's code can honour (§7.7.4, §13.1): the one value
    the loader checks a document against and the CTK derives the
    harness surface from. A document may select a subset of this, never
    more.

    Build it with :meth:`sdk_default` or :meth:`from_capabilities` and
    the ``with_*`` methods. Timeout support is not a member: this SDK
    always bounds execution (:data:`INTERCEPTOR_TIMEOUT_SUPPORT`).
    """

    #: Points the host emits. Always includes the §3.2 floor.
    interception_points: frozenset[InterceptionPoint] = FLOOR_POINTS
    #: Closed vocabulary (:data:`CAPABILITIES`).
    capabilities: frozenset[str] = frozenset({"host_declaration"})
    #: Profiles and the knob values supported under each.
    profiles: Mapping[CompositionProfile, KnobSupport] = field(default_factory=_all_profiles_full)
    #: The posture the code implements (§13.1): ``continue`` or ``terminate``.
    tool_seam_host_error: str = "continue"
    #: Whether the host may declare ``buffered_output: false`` (§12.1a).
    streams_unbuffered: bool = False
    #: The §12.1a exposure bound the host enforces. Required when
    #: ``capabilities`` names ``incremental_output``.
    exposure_bound: str | None = None
    #: Contract versions the host accepts; a subset of
    #: :data:`~agent_hooks.SUPPORTED_DECLARATION_VERSIONS`.
    declaration_versions: frozenset[str] = frozenset(SUPPORTED_DECLARATION_VERSIONS)

    @classmethod
    def sdk_default(cls) -> HostSurface:
        """The smallest honest surface for this SDK: the lifecycle
        floor, ``host_declaration``, every profile with every knob
        value, posture ``continue``, buffered output and every accepted
        contract version. A host adds what its runtime does."""
        return cls()

    @classmethod
    def from_capabilities(
        cls, capabilities: Iterable[str], tool_seam_host_error: str = "continue"
    ) -> HostSurface:
        """The surface the CTK derives from a harness's capability list
        and posture (§7.7.9): the floor plus the model points iff
        ``model_calls`` plus the tool points iff ``tool_calls``. A list
        naming ``incremental_output`` needs :meth:`with_exposure_bound`
        as well, or the core refuses the surface."""
        points = set(FLOOR_POINTS)
        caps: set[str] = set()
        unbuffered = False
        for c in capabilities:
            if c == "model_calls":
                points |= {InterceptionPoint.PRE_MODEL_CALL, InterceptionPoint.POST_MODEL_CALL}
            elif c == "tool_calls":
                points |= {InterceptionPoint.PRE_TOOL_CALL, InterceptionPoint.POST_TOOL_CALL}
            elif c == "incremental_output":
                unbuffered = True
            caps.add(c)
        return cls(
            interception_points=frozenset(points),
            capabilities=frozenset(caps),
            tool_seam_host_error=tool_seam_host_error,
            streams_unbuffered=unbuffered,
        )

    def with_points(self, points: Iterable[InterceptionPoint | str]) -> HostSurface:
        """Add the model points, the tool points, or both."""
        return replace(
            self, interception_points=self.interception_points | {_point(p) for p in points}
        )

    def with_capabilities(self, capabilities: Iterable[str]) -> HostSurface:
        """Add capabilities."""
        return replace(self, capabilities=self.capabilities | set(capabilities))

    def with_exposure_bound(self, bound: str) -> HostSurface:
        """State the §12.1a exposure bound an incremental host enforces.
        Also marks the host as able to declare ``buffered_output: false``."""
        return replace(self, exposure_bound=bound, streams_unbuffered=True)

    def to_wire(self) -> dict[str, Any]:
        """The JSON form the core's ``declaration_resolve`` receives."""
        out: dict[str, Any] = {
            "interception_points": _points_sorted(self.interception_points),
            "capabilities": sorted(self.capabilities),
            "profiles": {p.value: k.to_wire() for p, k in sorted(self.profiles.items())},
            "tool_seam_host_error": self.tool_seam_host_error,
            "streams_unbuffered": self.streams_unbuffered,
            "interceptor_timeout": INTERCEPTOR_TIMEOUT_SUPPORT,
            "declaration_versions": sorted(self.declaration_versions),
        }
        if self.exposure_bound is not None:
            out["exposure_bound"] = self.exposure_bound
        return out

    def validate(self) -> None:
        """Check this surface against the closed vocabularies, the §3.2
        floor and the omission pairs, in the core. A surface that fails
        is a programming error of the host (``ValueError``), never a
        refusal of a document."""
        probe = {
            "declaration": DECLARATION_VERSION,
            "configuration": {"posture": {"tool_seam_host_error": self.tool_seam_host_error}},
            "bindings": [],
        }
        try:
            _core.declaration_resolve(_compact(probe), _compact({"surface": self.to_wire()}))
        except _core.AgentHooksCoreError as e:
            detail = str(getattr(e, "detail", e))
            if getattr(e, "code", "") != "marshal_error":
                detail = f"a minimal document does not resolve against it ({e.code}): {detail}"
            raise ValueError(f"host surface is invalid: {detail}") from None


# ---- registry ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BindingContext:
    """What a kind resolver learns about the binding it builds (§7.7.5)."""

    id: str
    kind: str
    #: The resolved ``at`` set.
    at: frozenset[InterceptionPoint]
    #: The resolved per-binding bound in seconds; ``None`` is unbounded.
    timeout: float | None
    #: The document's ``host`` block, when present.
    host: Mapping[str, Any] | None
    #: The document's ``declaration`` value.
    declaration_version: str


#: Host code that turns one binding's ``config`` into one interceptor,
#: or refuses it by raising (the message MUST NOT echo the config).
KindResolver = Callable[[Any, BindingContext], Interceptor]


def valid_reference(name: str) -> bool:
    """Reference grammar for resolver and redactor names and binding
    ids: ``^[a-z][a-z0-9_-]{0,63}$``."""
    return _REFERENCE_RE.fullmatch(name) is not None


def valid_kind(kind: str) -> bool:
    """Binding kind grammar (§7.7.5): dot-separated lowercase segments,
    at least two, at most 128 characters."""
    segments = kind.split(".")
    return (
        len(kind) <= MAX_KIND_LEN
        and len(segments) >= 2
        and all(_KIND_SEGMENT_RE.fullmatch(s) for s in segments)
    )


class HostRegistry:
    """Everything a host registers in code for a declaration to
    reference (§7.7.5): the code surface, kind resolvers, custom
    identity providers, approval resolvers and approval redactors.

    Kinds under the reserved ``agent_hooks`` and ``ctk`` segments are
    refused; :meth:`for_conformance` opens ``ctk`` for the CTK runner.
    Registering a name twice, or under the wrong grammar, is a
    programming error (``ValueError``), not a refusal of any document.
    """

    __slots__ = (
        "_allow_reserved",
        "_approval_redactors",
        "_approval_resolvers",
        "_identity_providers",
        "_kinds",
        "_surface",
    )

    def __init__(self, surface: HostSurface | None = None) -> None:
        self._surface = surface if surface is not None else HostSurface.sdk_default()
        self._surface.validate()
        self._allow_reserved = False
        self._kinds: dict[str, KindResolver] = {}
        self._identity_providers: dict[str, Callable[[AgentContext], str]] = {}
        self._approval_resolvers: dict[str, ApprovalResolver] = {}
        self._approval_redactors: dict[str, Callable[[AgentContext], AgentContext]] = {}

    @classmethod
    def for_conformance(cls, surface: HostSurface | None = None) -> HostRegistry:
        """The conformance kit's registry: as the constructor, but the
        ``ctk`` kind segment may be registered."""
        out = cls(surface)
        out._allow_reserved = True
        return out

    @property
    def surface(self) -> HostSurface:
        return self._surface

    def kind(self, kind: str, resolver: KindResolver) -> HostRegistry:
        """Register a kind resolver: ``resolver(config, BindingContext)``
        returns one interceptor or raises."""
        if not valid_kind(kind):
            raise ValueError(
                f"host registry: kind {_q(kind)} does not match the kind grammar (see spec §7.7.5)"
            )
        head = kind.split(".", 1)[0]
        if head in _RESERVED_KIND_SEGMENTS and not (self._allow_reserved and head == "ctk"):
            raise ValueError(
                f"host registry: kind {_q(kind)} uses the reserved segment {_q(head)} "
                "(see spec §7.7.5)"
            )
        if kind in self._kinds:
            raise ValueError(f"host registry: kind {_q(kind)} registered twice")
        self._kinds[kind] = resolver
        return self

    def identity_provider(self, name: str, fn: Callable[[AgentContext], str]) -> HostRegistry:
        """Register a custom identity provider (§10.1 name rules apply)."""
        if not _PROVIDER_RE.fullmatch(name) or name.startswith("jcs"):
            raise ValueError(
                f"host registry: identity provider name {_q(name)} must match "
                "^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (§10.1)"
            )
        if len(name) > MAX_ID_LEN:
            raise ValueError(
                f"host registry: identity provider name {_q(name)} exceeds {MAX_ID_LEN} characters"
            )
        if name in self._identity_providers:
            raise ValueError(f"host registry: identity provider {_q(name)} registered twice")
        self._identity_providers[name] = fn
        return self

    def approval_resolver(self, name: str, resolver: ApprovalResolver) -> HostRegistry:
        """Register an approval resolver under a reference name."""
        self._check_reference(name, "approval resolver")
        if name in self._approval_resolvers:
            raise ValueError(f"host registry: approval resolver {_q(name)} registered twice")
        self._approval_resolvers[name] = resolver
        return self

    def approval_redactor(
        self, name: str, fn: Callable[[AgentContext], AgentContext]
    ) -> HostRegistry:
        """Register an approval redactor under a reference name."""
        self._check_reference(name, "approval redactor")
        if name in self._approval_redactors:
            raise ValueError(f"host registry: approval redactor {_q(name)} registered twice")
        self._approval_redactors[name] = fn
        return self

    @staticmethod
    def _check_reference(name: str, what: str) -> None:
        if not valid_reference(name):
            raise ValueError(
                f"host registry: {what} name {_q(name)} does not match ^[a-z][a-z0-9_-]{{0,63}}$"
            )

    def names(self) -> dict[str, list[str]]:
        """The registered names, derived from what was registered and
        never hand-written (§7.7.5). Steps 9 and 10 check against them."""
        return {
            "identity_providers": sorted(self._identity_providers),
            "approval_resolvers": sorted(self._approval_resolvers),
            "approval_redactors": sorted(self._approval_redactors),
            "kinds": sorted(self._kinds),
        }

    def _host_json(self) -> str:
        return _compact({"surface": self._surface.to_wire(), **self.names()})

    def resolve(self, declaration: HostDeclaration) -> ResolvedDeclaration:
        """Steps 2 to 10 of §7.7.6 in the core: validate the document and
        resolve it against this registry's surface and names. Raises
        :class:`DeclarationError` on refusal. Does not run the kind
        resolvers (step 11); :meth:`InterceptionEmitter.from_declaration`
        does, and builds the emitter."""
        try:
            resolved = _core.declaration_resolve(declaration.text, self._host_json())
        except _core.AgentHooksCoreError as e:
            code = str(getattr(e, "code", ""))
            if code.startswith("declaration_error:"):
                raise DeclarationError._from_core(e) from None
            # The core rejected this SDK's own description of its code,
            # never the document: a defect here, not a refusal.
            raise RuntimeError(
                f"host registry description rejected by the core ({code}): "
                f"{getattr(e, 'detail', e)}"
            ) from None
        return ResolvedDeclaration(json.loads(resolved))

    # Looked up again at construction time, so bookkeeping drift between
    # the names the core checked and what this registry holds fails
    # closed (§7.7.5).
    def _kind_resolver(self, kind: str) -> KindResolver | None:
        return self._kinds.get(kind)

    def _identity_fn(self, name: str) -> Callable[[AgentContext], str] | None:
        return self._identity_providers.get(name)

    def _approval_resolver_ref(self, name: str) -> ApprovalResolver | None:
        return self._approval_resolvers.get(name)

    def _redactor_fn(self, name: str) -> Callable[[AgentContext], AgentContext] | None:
        return self._approval_redactors.get(name)


# ---- document ------------------------------------------------------------------

_IO_CLASS: Final[dict[int, str]] = {
    errno.ENOENT: "NotFound",
    errno.EACCES: "PermissionDenied",
    errno.EPERM: "PermissionDenied",
    errno.EISDIR: "IsADirectory",
    errno.ENOTDIR: "NotADirectory",
    errno.ELOOP: "FilesystemLoop",
    errno.ENAMETOOLONG: "InvalidFilename",
}


def _io_class(e: OSError) -> str:
    """The OS error class, never file contents (§7.7.6)."""
    if e.errno in _IO_CLASS:
        return _IO_CLASS[e.errno]
    return errno.errorcode.get(e.errno or 0, type(e).__name__)


@dataclass(frozen=True, slots=True)
class HostDeclaration:
    """A host declaration document as read from a path, JSON text, a
    value or the builder, before the core has seen it.

    Step 1 (the file read, ``unreadable``) runs in :meth:`from_path`;
    the value path refuses what it cannot serialize (``malformed``).
    Steps 2 to 10 run in the core when the document is resolved against
    a :class:`HostRegistry` (:meth:`HostRegistry.resolve`,
    :meth:`InterceptionEmitter.from_declaration`), with one refusal
    class per document on every SDK.
    """

    #: The JSON text the core receives.
    text: str

    @classmethod
    def from_path(cls, path: str | os.PathLike[str]) -> HostDeclaration:
        """Step 1: open exactly ``path``, require a regular file of at
        most :data:`MAX_DOCUMENT_BYTES`, strict UTF-8 without a
        byte-order mark, read once."""

        def unreadable(detail: str) -> DeclarationError:
            return _single(DeclarationErrorClass.UNREADABLE, "", detail)

        try:
            meta = os.stat(path)
        except OSError as e:
            raise unreadable(f"cannot stat: {_io_class(e)}") from None
        if not stat.S_ISREG(meta.st_mode):
            raise unreadable("not a regular file")
        if meta.st_size > MAX_DOCUMENT_BYTES:
            raise unreadable(f"document is {meta.st_size} bytes; the bound is {MAX_DOCUMENT_BYTES}")
        # A bounded read: a file that grows between the stat and the
        # read is still loaded only up to the bound plus one byte.
        try:
            with open(path, "rb") as f:
                data = f.read(MAX_DOCUMENT_BYTES + 1)
        except OSError as e:
            raise unreadable(f"cannot read: {_io_class(e)}") from None
        if len(data) > MAX_DOCUMENT_BYTES:
            raise unreadable(f"document is {len(data)} bytes; the bound is {MAX_DOCUMENT_BYTES}")
        if data.startswith(b"\xef\xbb\xbf"):
            raise unreadable("document starts with a byte-order mark")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise unreadable("document is not valid UTF-8") from None
        return cls(text)

    @classmethod
    def from_json(cls, text: str) -> HostDeclaration:
        """The JSON text path (steps 2 to 10 run in the core at resolve)."""
        if not isinstance(text, str):
            raise TypeError(f"from_json takes the document text (got {type(text).__name__})")
        return cls(text)

    @classmethod
    def from_value(cls, value: Any) -> HostDeclaration:
        """The value path: ``value`` is serialized to compact JSON and
        handed to the text path, so size, depth and shape checks are the
        same core code on every path. A value the wire cannot carry (a
        non-finite number, a non-JSON type) is ``malformed``."""
        try:
            text = _compact(value)
        except (TypeError, ValueError) as e:
            raise _single(DeclarationErrorClass.MALFORMED, "", f"cannot serialize: {e}") from None
        return cls(text)

    @staticmethod
    def builder() -> DeclarationBuilder:
        """A builder for the code path (§7.7.7)."""
        return DeclarationBuilder()

    def as_value(self) -> Any:
        """The document parsed as a Python value (duplicate keys
        collapse here; the core refuses them on the text)."""
        return json.loads(self.text)


_UNSET: Any = object()


class DeclarationBuilder:
    """Builds a declaration document in code, one setter per member
    (§7.7.7). :meth:`build` hands the document to
    :meth:`HostDeclaration.from_value`, so the code path is validated by
    the same core function, with the same classes, as a file.

    The constructor starts with ``declaration`` set to
    :data:`~agent_hooks.DECLARATION_VERSION` and ``bindings`` empty;
    :meth:`empty` starts with nothing, for harnesses that must express
    an incomplete document.
    """

    __slots__ = ("_doc",)

    def __init__(self) -> None:
        self._doc: dict[str, Any] = {"declaration": DECLARATION_VERSION, "bindings": []}

    @classmethod
    def empty(cls) -> DeclarationBuilder:
        out = cls()
        out._doc = {}
        return out

    def _configuration(self) -> dict[str, Any]:
        out: dict[str, Any] = self._doc.setdefault("configuration", {})
        return out

    def _configuration_sub(self, key: str) -> dict[str, Any]:
        out: dict[str, Any] = self._configuration().setdefault(key, {})
        return out

    def _surface(self) -> dict[str, Any]:
        out: dict[str, Any] = self._doc.setdefault("surface", {})
        return out

    def version(self, v: str) -> DeclarationBuilder:
        """``declaration`` (defaults to :data:`~agent_hooks.DECLARATION_VERSION`)."""
        self._doc["declaration"] = v
        return self

    def spec(self, v: str) -> DeclarationBuilder:
        self._doc["spec"] = v
        return self

    def id(self, v: str) -> DeclarationBuilder:
        self._doc["id"] = v
        return self

    def host(self, name: str, version: str | None = None) -> DeclarationBuilder:
        h: dict[str, Any] = {"name": name}
        if version is not None:
            h["version"] = version
        self._doc["host"] = h
        return self

    def mode(self, mode: EnforcementMode | str) -> DeclarationBuilder:
        self._configuration()["mode"] = mode.value if isinstance(mode, EnforcementMode) else mode
        return self

    def composition(self, c: CompositionConfig) -> DeclarationBuilder:
        """The composition as the host states it. A knob the profile does
        not consult is written out and refused by :meth:`build`, exactly
        as in a file."""
        self._configuration()["composition"] = c.to_wire()
        return self

    def identity_provider(self, name: str | None) -> DeclarationBuilder:
        """``"jcs-sha256"`` or a custom name; ``None`` is identity-unbound
        (written as ``null``)."""
        self._configuration()["identity_provider"] = name
        return self

    def approval_resolver(self, name: str | None) -> DeclarationBuilder:
        self._configuration_sub("approval")["resolver"] = name
        return self

    def approval_redactor(self, name: str | None) -> DeclarationBuilder:
        self._configuration_sub("approval")["redactor"] = name
        return self

    def tool_seam_host_error(self, posture: str) -> DeclarationBuilder:
        self._configuration_sub("posture")["tool_seam_host_error"] = posture
        return self

    def interceptor_timeout_ms(self, ms: int | None) -> DeclarationBuilder:
        """``None`` writes ``null`` (unbounded)."""
        self._configuration_sub("timeouts")["interceptor_ms"] = ms
        return self

    def approval_resolver_timeout_ms(self, ms: int | None) -> DeclarationBuilder:
        """``None`` writes ``null`` (unbounded)."""
        self._configuration_sub("timeouts")["approval_resolver_ms"] = ms
        return self

    def max_buffered_records(self, n: int | None) -> DeclarationBuilder:
        """``None`` writes ``null`` (unbounded)."""
        self._configuration_sub("records")["max_buffered"] = n
        return self

    def surface_points(self, points: Iterable[InterceptionPoint | str]) -> DeclarationBuilder:
        self._surface()["interception_points"] = _points_sorted(_point(p) for p in points)
        return self

    def surface_capabilities(self, capabilities: Iterable[str]) -> DeclarationBuilder:
        self._surface()["capabilities"] = sorted(set(capabilities))
        return self

    def surface_profile(
        self, profile: CompositionProfile | str, knobs: KnobSupport
    ) -> DeclarationBuilder:
        """Declare support for one profile and its knob values."""
        key = profile.value if isinstance(profile, CompositionProfile) else profile
        self._surface().setdefault("profiles", {})[key] = knobs.to_wire()
        return self

    def buffered_output(
        self, buffered: bool, exposure_bound: str | None = None
    ) -> DeclarationBuilder:
        """``buffered_output`` and, when ``False``, the required exposure bound."""
        s = self._surface()
        s["buffered_output"] = buffered
        if exposure_bound is not None:
            s["exposure_bound"] = exposure_bound
        else:
            s.pop("exposure_bound", None)
        return self

    def surface_declaration_versions(self, versions: Iterable[str]) -> DeclarationBuilder:
        self._surface()["declaration_versions"] = sorted(set(versions))
        return self

    def bind(
        self,
        id: str,
        kind: str,
        config: Any = None,
        *,
        at: Iterable[InterceptionPoint | str] | None = None,
        timeout_ms: int | None = _UNSET,
    ) -> DeclarationBuilder:
        """Append one binding. ``config`` defaults to ``{}``; ``at=None``
        binds at every surface point; ``timeout_ms`` left out inherits
        the configured interceptor timeout, ``None`` writes ``null``
        (unbounded), an integer bounds."""
        b: dict[str, Any] = {"id": id, "kind": kind, "config": {} if config is None else config}
        if at is not None:
            b["at"] = _points_sorted(_point(p) for p in at)
        if timeout_ms is not _UNSET:
            b["timeout_ms"] = timeout_ms
        self._doc.setdefault("bindings", []).append(b)
        return self

    def extension(self, key: str, value: Any) -> DeclarationBuilder:
        """One ``extensions`` entry, kept verbatim."""
        self._doc.setdefault("extensions", {})[key] = value
        return self

    def raw(self, key: str, value: Any) -> DeclarationBuilder:
        """Set a top-level member verbatim. For members this builder has
        no setter for; the result is validated like any other document
        (an unknown member is refused as ``unknown_field``)."""
        self._doc[key] = value
        return self

    def to_value(self) -> dict[str, Any]:
        """The document as built, before validation."""
        return copy.deepcopy(self._doc)

    def build(self) -> HostDeclaration:
        """The document, through :meth:`HostDeclaration.from_value`."""
        return HostDeclaration.from_value(self._doc)


# ---- resolved form -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResolvedBinding:
    """One binding with ``at`` and ``timeout_ms`` filled."""

    id: str
    kind: str
    config: Any
    at: frozenset[InterceptionPoint]
    timeout_ms: int | None


@dataclass(frozen=True, slots=True)
class ResolvedDeclaration:
    """The resolved declaration (§7.7.3 "Resolved form") as the core
    returned it: every default filled, composition knobs resolved as
    §7.2 resolves them, ``$schema`` dropped, sets sorted. Its canonical
    JSON is the equivalence oracle for the construction paths (§7.7.7).
    """

    _wire: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return copy.deepcopy(self._wire)

    def canonical_json(self) -> str:
        """RFC 8785 canonical JSON of the resolved form."""
        return _core.canonical_json(_compact(self._wire))

    @property
    def version(self) -> str:
        """The contract version the document carried."""
        return str(self._wire["declaration"])

    @property
    def declaration(self) -> str:
        return self.version

    @property
    def spec(self) -> str:
        return str(self._wire["spec"])

    @property
    def id(self) -> str | None:
        return self._wire.get("id")

    @property
    def host(self) -> Mapping[str, Any] | None:
        return self._wire.get("host")

    def _member(self, key: str) -> Mapping[str, Any]:
        out: Mapping[str, Any] = self._wire[key]
        return out

    @property
    def configuration(self) -> Mapping[str, Any]:
        return self._member("configuration")

    @property
    def surface(self) -> Mapping[str, Any]:
        return self._member("surface")

    @property
    def extensions(self) -> Mapping[str, Any]:
        return self._member("extensions")

    @property
    def mode(self) -> EnforcementMode:
        return EnforcementMode(self.configuration["mode"])

    @property
    def composition(self) -> CompositionConfig:
        """The composition ``finalize`` stamps; the §7.2 defaults are
        already filled in."""
        return CompositionConfig.from_wire(self.configuration["composition"])

    @property
    def identity_provider(self) -> str | None:
        """The declared identity provider name (``None`` is unbound)."""
        name: str | None = self.configuration["identity_provider"]
        return name

    @property
    def bindings(self) -> tuple[ResolvedBinding, ...]:
        return tuple(
            ResolvedBinding(
                id=b["id"],
                kind=b["kind"],
                config=b["config"],
                at=frozenset(InterceptionPoint(p) for p in b["at"]),
                timeout_ms=b["timeout_ms"],
            )
            for b in self._wire["bindings"]
        )


def _ms_to_seconds(ms: int | None) -> float | None:
    return None if ms is None else ms / 1000.0


__all__ = [
    "CAPABILITIES",
    "FLOOR_POINTS",
    "INTERCEPTOR_TIMEOUT_SUPPORT",
    "MAX_DETAIL_LEN",
    "MAX_DOCUMENT_BYTES",
    "MAX_ID_LEN",
    "MAX_KIND_LEN",
    "BindingContext",
    "DeclarationBuilder",
    "DeclarationError",
    "DeclarationErrorClass",
    "Finding",
    "HostDeclaration",
    "HostRegistry",
    "HostSurface",
    "KindResolver",
    "KnobSupport",
    "ResolvedBinding",
    "ResolvedDeclaration",
    "valid_kind",
    "valid_reference",
]
