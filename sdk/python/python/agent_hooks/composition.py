# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Composition profiles and knobs (§7).

Composition is **host configuration**, never verdict content (§7.1):
the host declares — before dispatch — which profile governs execution
and aggregation, and the profile in effect is recorded on every
interception record (§10.3). The profile set is closed (§7.2).

Aggregation itself (severity-max winner, §7.3 metadata unions) delegates
to the Rust core (``_core.compose_aggregate``) so all SDKs agree byte
for byte; this module carries only the configuration value type.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class CompositionProfile(str, Enum):
    """The closed profile set (§7.2)."""

    SEQUENTIAL_FIRST_DENY = "sequential/first_deny"
    SEQUENTIAL_RUN_ALL = "sequential/run_all"
    PARALLEL_STRICTEST = "parallel/strictest"
    PARALLEL_UNANIMOUS = "parallel/unanimous"

    @property
    def is_sequential(self) -> bool:
        """Whether interceptors observe predecessors' transforms (§7.4)
        vs. isolated snapshots (§7.5)."""
        return self in {
            CompositionProfile.SEQUENTIAL_FIRST_DENY,
            CompositionProfile.SEQUENTIAL_RUN_ALL,
        }


class OnApproval(str, Enum):
    """``sequential/first_deny`` knob (§7.4): what a permit resolution
    does to the rest of the fold."""

    #: The resolution becomes the combined verdict; the emission ends
    #: (``fold_truncated: true``).
    STOP = "stop"
    #: The resolution substitutes for the denying interceptor's verdict
    #: and the fold continues.
    RESUME = "resume"


class SynthesisPolicy(str, Enum):
    """``"deny" | "approval"`` knob value (§7.5): synthesize a plain
    deny, or a liftable one and consult the seam."""

    DENY = "deny"
    APPROVAL = "approval"


@dataclass(frozen=True, slots=True)
class CompositionConfig:
    """The composition profile and knobs in effect for one emission
    (§7.1, §10.3). Serialized verbatim into the record's ``composition``
    block."""

    profile: CompositionProfile = CompositionProfile.SEQUENTIAL_FIRST_DENY
    #: ``sequential/first_deny`` only.
    on_approval: OnApproval | None = None
    #: ``parallel/unanimous`` only.
    on_disagreement: SynthesisPolicy | None = None
    #: Parallel profiles only.
    on_transform_conflict: SynthesisPolicy | None = None

    @classmethod
    def default(cls) -> CompositionConfig:
        """The pre-P-003 behaviour: ``sequential/first_deny`` with
        ``on_approval: stop``. A default, not a conformance baseline —
        no profile is mandatory (§7.2, §13.1)."""
        return cls.first_deny(OnApproval.STOP)

    @classmethod
    def first_deny(cls, on_approval: OnApproval = OnApproval.STOP) -> CompositionConfig:
        return cls(profile=CompositionProfile.SEQUENTIAL_FIRST_DENY, on_approval=on_approval)

    @classmethod
    def run_all(cls) -> CompositionConfig:
        return cls(profile=CompositionProfile.SEQUENTIAL_RUN_ALL)

    @classmethod
    def strictest(
        cls, on_transform_conflict: SynthesisPolicy = SynthesisPolicy.DENY
    ) -> CompositionConfig:
        return cls(
            profile=CompositionProfile.PARALLEL_STRICTEST,
            on_transform_conflict=on_transform_conflict,
        )

    @classmethod
    def unanimous(
        cls,
        on_disagreement: SynthesisPolicy = SynthesisPolicy.DENY,
        on_transform_conflict: SynthesisPolicy = SynthesisPolicy.DENY,
    ) -> CompositionConfig:
        return cls(
            profile=CompositionProfile.PARALLEL_UNANIMOUS,
            on_disagreement=on_disagreement,
            on_transform_conflict=on_transform_conflict,
        )

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"profile": self.profile.value}
        if self.on_approval is not None:
            out["on_approval"] = self.on_approval.value
        if self.on_disagreement is not None:
            out["on_disagreement"] = self.on_disagreement.value
        if self.on_transform_conflict is not None:
            out["on_transform_conflict"] = self.on_transform_conflict.value
        return out

    @classmethod
    def from_wire(cls, obj: dict[str, Any] | None) -> CompositionConfig:
        """Parse a §10.3 ``composition`` block; ``None`` (absent) means
        the default profile."""
        if obj is None:
            return cls.default()
        knob = {
            k: e(obj[k])
            for k, e in (
                ("on_approval", OnApproval),
                ("on_disagreement", SynthesisPolicy),
                ("on_transform_conflict", SynthesisPolicy),
            )
            if obj.get(k) is not None
        }
        return cls(profile=CompositionProfile(obj["profile"]), **knob)
