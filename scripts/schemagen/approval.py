# Copyright (c) Microsoft. All rights reserved.

"""approval.schema.json: the approval request and resolution shapes (§9)."""

from __future__ import annotations

from .vocabulary import const, document, obj, ref, schema, string

REQUEST = obj(
    additionalProperties=False,
    required=["context_identity", "interception_point", "verdict"],
    properties={
        "context_identity": string(nullable=True),
        "interception_point": ref("interception-point.schema.json"),
        "verdict": schema(
            description="The liftable deny being consulted: an interceptor's (passes §5, "
            "verdict.schema.json) or the host-synthesized §7.5 shape, whose reason is a "
            "reserved host_error:* string that §5 forbids interceptors to emit — so this "
            "member is validated against the §5 schema only when its reason is not "
            "host_error:*.",
            type="object",
            required=["decision"],
            properties={"decision": const("deny")},
        ),
        "context": schema(
            description="The AgentContext as presented to the resolver. MAY be redacted per "
            "host policy.",
            ref="agent-context.schema.json",
        ),
    },
)

RESOLUTION = obj(
    additionalProperties=False,
    required=["outcome", "context_identity"],
    properties={
        "outcome": string(enum=["approve", "reject", "unresolved"]),
        "context_identity": string(
            nullable=True,
            description="MUST equal the request's context_identity byte for byte (echo rule, "
            "§9); null echoes as null.",
        ),
        "verdict": ref("verdict.schema.json"),
    },
    allOf=[
        schema(
            if_=schema(properties={"outcome": const("unresolved")}),
            then=schema(not_=schema(required=["verdict"])),
            else_=schema(required=["verdict"]),
        ),
        schema(
            if_=schema(properties={"outcome": const("approve")}),
            then=schema(
                properties={
                    "verdict": schema(
                        properties={"decision": schema(enum=["allow", "transform"])}
                    )
                }
            ),
        ),
        schema(
            if_=schema(properties={"outcome": const("reject")}),
            then=schema(
                properties={"verdict": schema(properties={"decision": const("deny")})}
            ),
        ),
    ],
)

SCHEMA = document(
    "approval",
    title="Agent Hooks — approval seam",
    description="Approval request and resolution shapes for lifting a liftable deny "
    "(AGENT-HOOKS-0.1 §9). context_identity is an opaque provider-produced string, or null "
    "when identity_provider is null (§10.1); the only normative constraint is the echo rule.",
    body=schema(defs={"request": REQUEST, "resolution": RESOLUTION}),
)
