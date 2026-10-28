# Copyright (c) Microsoft. All rights reserved.

"""interception-record.schema.json: the host-side record of one emission (§10.3)."""

from __future__ import annotations

from .common import (
    COMPOSITION_PROFILES,
    DECISIONS,
    DECLARATION_VERSION,
    MODES,
    ON_APPROVAL,
    ON_DISAGREEMENT,
    ON_TRANSFORM_CONFLICT,
)
from .vocabulary import (
    array,
    boolean,
    const,
    document,
    integer,
    obj,
    ref,
    schema,
    string,
)

#: Profiles that produce more than one verdict per emission (§7.4).
MULTI_VERDICT_PROFILES = COMPOSITION_PROFILES[1:]

VERDICT_PROJECTION = schema(
    description="The payload-free projection of the combined verdict (§10.3): "
    "transform.value dropped, approval members stripped, messages truncated to 256 UTF-8 "
    "bytes. warnings[].reason may carry host_warning:control_failed (§6.3.1, §11.1).",
    type="object",
    properties={
        "transform": obj(
            required=["path"],
            additionalProperties=False,
            properties={"path": string()},
        ),
        "approval": obj(
            additionalProperties=False,
            description="Presence only; members are stripped by the projection.",
        ),
    },
)

IDENTITY_PROVIDER = string(
    nullable=True,
    description='The declared identity provider (§10.1): "jcs-sha256", a host-defined id '
    "(name rules enforced: ^[a-z][a-z0-9_-]*$ and never a jcs prefix), or null "
    "(identity-unbound).",
    anyOf=[
        const(None),
        const("jcs-sha256"),
        schema(
            allOf=[
                string(pattern="^[a-z][a-z0-9_-]*$"),
                schema(not_=schema(pattern="^jcs")),
            ]
        ),
    ],
)

COMPOSITION = obj(
    additionalProperties=False,
    required=["profile"],
    properties={
        "profile": string(enum=COMPOSITION_PROFILES),
        "on_approval": string(enum=ON_APPROVAL),
        "on_disagreement": string(enum=ON_DISAGREEMENT),
        "on_transform_conflict": string(enum=ON_TRANSFORM_CONFLICT),
    },
    description="The composition profile and knobs in effect for this emission (§7.1).",
)

VERDICT_SLOT = obj(
    additionalProperties=False,
    required=["index", "decision"],
    properties={
        "index": integer(minimum=0),
        "decision": string(enum=DECISIONS),
        "reason": string(nullable=True),
        "name": string(
            description="Host-chosen payload-free registration identifier for the "
            "interceptor at index (§10.3)."
        ),
        "substituted_for": string(
            enum=[
                "host_error:interceptor_failed",
                "host_error:interceptor_timeout",
                "host_error:verdict_invalid",
            ],
            description="Present iff this slot's verdict is the allow the host substituted "
            "under on_error: continue (§6.3.1): the host_error reason the §6.3 deny would "
            "have carried. The entry's decision is allow and reason is absent.",
        ),
    },
)

SCHEMA = document(
    "interception-record",
    title="Agent Hooks — interception record",
    description="Host-side record of one emission (AGENT-HOOKS-0.1 §10.3). Payload-free: "
    "identities (when a provider is declared) bind the record to the exact "
    "pre/post-composition context; session_id/sequence/decided_by provide ordering and "
    "attribution; composition makes the record interpretable without out-of-band host "
    "configuration.",
    body=obj(
        additionalProperties=False,
        required=[
            "interception_point",
            "mode",
            "verdict",
            "input_identity",
            "enforced_identity",
            "identity_provider",
            "session_id",
            "sequence",
            "composition",
            "interceptors_registered",
        ],
        properties={
            "interception_point": ref("interception-point.schema.json"),
            "mode": string(enum=MODES),
            "verdict": VERDICT_PROJECTION,
            "input_identity": string(
                nullable=True,
                description="Identity provider output on the context before dispatch; null "
                "iff identity_provider is null.",
            ),
            "enforced_identity": string(
                nullable=True,
                description="Identity provider output after composition completes; null iff "
                "identity_provider is null.",
            ),
            "identity_provider": IDENTITY_PROVIDER,
            "session_id": string(
                description="ctx.session.id — correlates records across a session."
            ),
            "sequence": integer(
                description="ctx.sequence — total order of records within the session "
                "(§12.2.3)."
            ),
            "timestamp": string(
                description="OPTIONAL. The context's RFC 3339 timestamp, copied verbatim "
                "(§10.3); absent when the context lacked the field."
            ),
            "trace": obj(
                additionalProperties=False,
                properties={"trace_id": string(), "span_id": string()},
                description="OPTIONAL. W3C Trace Context identifiers echoed from the "
                "context's optional trace block (§4.5, §10.3); absent when the context "
                "carried neither member.",
            ),
            "decided_by": integer(
                nullable=True,
                minimum=0,
                description="Registration index of the interceptor whose verdict won "
                "aggregation or whose liftable deny was consulted (§7.6); null for a "
                "pure-allow combination or a host-synthesized verdict.",
            ),
            "composition": COMPOSITION,
            "declaration": string(
                pattern=DECLARATION_VERSION,
                description="OPTIONAL. The host declaration contract version the emitter "
                "was built from (§7.7.8), e.g. agent-hooks-declaration/1.0. Present iff the "
                "emitter was constructed from a declaration document; absent for a host "
                "configured in code. One closed-grammar string, so payload-free by "
                "construction.",
            ),
            "verdicts": array(
                items=VERDICT_SLOT,
                description="Payload-free per-interceptor summary. REQUIRED in multi-verdict "
                "profiles (sequential/run_all, parallel/*) and whenever any slot carries "
                "substituted_for (§6.3.1); otherwise OPTIONAL in sequential/first_deny.",
            ),
            "fold_truncated": boolean(
                description="true iff one or more registered interceptors were never invoked "
                "in this emission (short-circuit, approval-stop, or a failed fold-transform). "
                "Defined for the sequential profiles (§7.4)."
            ),
            "resolved_by": string(
                nullable=True,
                enum=["approval", "rejection", None],
                description='Consultation outcome (§7.6, §10.3): "approval" iff a permit '
                'resolution substituted for a verdict; "rejection" iff the seam was consulted '
                "and did not lift the deny; absent/null iff never consulted.",
            ),
            "interceptors_registered": integer(
                minimum=0,
                description="Number of interceptors registered at emission time (§10.3).",
            ),
        },
        allOf=[
            schema(
                if_=schema(
                    properties={
                        "composition": obj(
                            properties={"profile": schema(enum=MULTI_VERDICT_PROFILES)}
                        )
                    }
                ),
                then=schema(required=["verdicts"]),
            ),
            schema(
                description="§10.3: identities are null when identity_provider is null.",
                if_=schema(properties={"identity_provider": const(None)}),
                then=schema(
                    properties={
                        "input_identity": const(None),
                        "enforced_identity": const(None),
                    }
                ),
            ),
        ],
    ),
)
