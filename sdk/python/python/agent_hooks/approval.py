# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Approval seam for liftable denies (§9).

A **liftable deny** is a ``deny`` verdict carrying an ``approval``
block (§5.1). The host consults a registered resolver exactly when the
composition profile in effect says to (§7.4–§7.6), and never at
``agent_shutdown`` (§6.1a) or in ``evaluate_only`` mode (§8). A host
with no registered resolver enforces the liftable deny as a plain deny —
conformant behaviour, not an error.

``context_identity`` is ``None`` when the identity provider is ``null``
(§10.1) — the approval is then identity-unbound and the echo rule
applies to ``None`` itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from agent_hooks._types import InterceptionPoint, Verdict
from agent_hooks.context import AgentContext


class ApprovalOutcome(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"
    UNRESOLVED = "unresolved"


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """What the host hands the resolver when a profile consults the seam (§9)."""

    context_identity: str | None
    interception_point: InterceptionPoint
    verdict: Verdict
    context: AgentContext


@dataclass(frozen=True, slots=True)
class ApprovalResolution:
    """What the resolver returns (§9). ``context_identity`` MUST echo
    the request's byte for byte (``None`` echoes as ``None``)."""

    outcome: ApprovalOutcome
    context_identity: str | None
    verdict: Verdict | None = None

    def __post_init__(self) -> None:
        # Outcome/verdict *presence* is a type-level invariant (§9
        # validation step 2). Outcome/decision *consistency* (step 4:
        # approve carries a permit, reject a deny) is deliberately NOT
        # checked here: it is the host's ordered §9 validation, which
        # names `host_error:verdict_invalid` — an eager constructor
        # check would misreport it as a resolver failure.
        if self.outcome is ApprovalOutcome.UNRESOLVED:
            if self.verdict is not None:
                raise ValueError("unresolved resolution MUST NOT carry a verdict")
        elif self.verdict is None:
            raise ValueError("approve/reject resolution MUST carry a verdict")


@runtime_checkable
class ApprovalResolver(Protocol):
    """Host-registered callable that resolves a liftable deny (§9)."""

    def resolve(self, request: ApprovalRequest, /) -> ApprovalResolution: ...
