# Copyright (c) Microsoft. All rights reserved.

"""verdict.schema.json: the interceptor return value (§5)."""

from __future__ import annotations

from .common import DECISIONS
from .vocabulary import array, const, document, obj, ref, schema, string

TRANSFORM = obj(
    additionalProperties=False,
    required=["path"],
    properties={
        "path": string(
            pattern=r"^\$(target|policy_target)(\.|\[|$)",
            description="JSONPath rooted at $target (§5.2). $policy_target is a deprecated "
            "alias accepted through agent-hooks v0.2.",
        ),
        "value": schema(
            description="Any JSON value, including null. An absent member is equivalent "
            "to null (§5.2)."
        ),
    },
)

EVIDENCE = obj(
    additionalProperties=False,
    properties={
        "artefact": string(
            nullable=True,
            description="Content address (sha256:<hex>) or URI of an offline-verifiable proof.",
        ),
        "verification_pointers": obj(
            additionalProperties=string(),
            description="Named URIs an auditor MAY consult. Hosts MUST NOT dereference "
            "automatically (§14).",
        ),
    },
)

WARNING = obj(
    additionalProperties=False,
    properties={
        "reason": string(
            nullable=True,
            pattern="^(?!host_error:|host_warning:).*",
            description="Interceptor-supplied warning identifier. The host_error: prefix is "
            "reserved for host-synthesized failures (§11) and host_warning: for "
            "host-synthesized warnings (§11.1); an interceptor warning with either prefix "
            "fails §5 validation.",
        ),
        "message": string(nullable=True),
    },
)

SCHEMA = document(
    "verdict",
    title="Agent Hooks — verdict",
    description="Interceptor return value (AGENT-HOOKS-0.1 §5). Three decisions: allow "
    "(absorbs warn via warnings[]), deny (absorbs escalate via the approval block), "
    "transform. A verdict carries decision content only; composition is host "
    "configuration (§7.1).",
    body=obj(
        additionalProperties=False,
        required=["decision"],
        properties={
            "decision": string(enum=DECISIONS),
            "reason": string(
                nullable=True,
                pattern="^(?!host_error:).*",
                description="Interceptor-supplied machine identifier. The host_error: prefix "
                "is reserved for host-synthesized failures (§11).",
            ),
            "message": string(
                nullable=True, description="Human-readable text for the caller."
            ),
            "warnings": array(
                nullable=True,
                items=WARNING,
                description="Recorded concerns that do not affect control flow (§5.1). "
                "Permitted on any decision; unioned across an emission's verdicts (§7.3). "
                "Reasons starting with host_warning: are reserved for the host (§11.1).",
            ),
            "approval": obj(
                description="Present only on deny: marks the deny as liftable by the approval "
                "seam (§9). MAY be empty; reserved for approver-facing parameters."
            ),
            "transform": ref("#/$defs/transform"),
            "evidence": ref("#/$defs/evidence"),
            "result_labels": array(
                nullable=True,
                items=string(),
                description="Interceptor-supplied labels the host MUST persist with the "
                "produced data and resurface on later interception points (§5.4).",
            ),
        },
        allOf=[
            schema(
                description="transform body REQUIRED iff decision == transform (§5).",
                if_=schema(properties={"decision": const("transform")}),
                then=schema(required=["transform"]),
                else_=schema(not_=schema(required=["transform"])),
            ),
            schema(
                description="approval block permitted only on deny (§5.1).",
                if_=schema(required=["approval"]),
                then=schema(properties={"decision": const("deny")}),
            ),
        ],
        defs={"transform": TRANSFORM, "evidence": EVIDENCE},
    ),
)
