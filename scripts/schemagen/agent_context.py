# Copyright (c) Microsoft. All rights reserved.

"""agent-context.schema.json and its per-point variants (§4).

The master schema admits every interception point and requires the
conditional payload of the point named in ``interception_point``. The
per-point variants under ``agent-context/`` fix that member to one value
and close that point's payload objects; the CTK validates against them.
"""

from __future__ import annotations

import copy

from .common import EXTENSION_KEY, INTERCEPTION_POINTS
from .emit import Layout
from .vocabulary import (
    ANY,
    Schema,
    array,
    boolean,
    const,
    document,
    integer,
    number,
    obj,
    ref,
    schema,
    string,
)

#: Members present at every point (§4.1).
CORE_REQUIRED = [
    "spec",
    "interception_point",
    "timestamp",
    "sequence",
    "agent",
    "session",
    "target",
]

#: interception_point -> the conditional members that point requires (§4.2).
CONDITIONAL: dict[str, list[str]] = {
    "agent_startup": ["agent_init"],
    "input": ["input"],
    "pre_model_call": ["model", "messages"],
    "post_model_call": ["model", "response"],
    "pre_tool_call": ["tool_call"],
    "post_tool_call": ["tool_call", "tool_result"],
    "output": ["output"],
    "agent_shutdown": ["summary"],
}
assert list(CONDITIONAL) == INTERCEPTION_POINTS

DEFS: dict[str, Schema] = {
    "agent_init": obj(
        required=["tools_registered"],
        properties={"tools_registered": array(items=string())},
    ),
    "input": obj(
        required=["content", "role"],
        properties={
            "content": ANY,
            "role": string(enum=["user", "system", "external"]),
        },
    ),
    "model": obj(
        required=["id"],
        properties={"id": string(), "vendor": string(), "params": obj()},
    ),
    "messages": array(
        items=obj(
            required=["role", "content"],
            properties={"role": string(), "content": ANY},
        )
    ),
    "response": obj(
        required=["content", "tool_calls", "finish_reason"],
        properties={
            "content": ANY,
            "tool_calls": array(
                items=obj(
                    required=["name", "args"],
                    properties={"id": string(), "name": string(), "args": obj()},
                )
            ),
            "finish_reason": string(),
        },
    ),
    "usage": obj(
        properties={
            "prompt_tokens": integer(minimum=0),
            "completion_tokens": integer(minimum=0),
        }
    ),
    "tool_call": obj(
        required=["id", "name", "args"],
        properties={
            "id": string(minLength=1),
            "name": string(minLength=1),
            "args": obj(),
            "content_hash": string(pattern="^sha256:[0-9a-f]{64}$"),
        },
    ),
    "tool_result": obj(
        required=["value", "is_error"],
        properties={
            "value": ANY,
            "is_error": boolean(),
            "duration_ms": number(minimum=0),
        },
    ),
    "tool_decl": obj(
        required=["name"],
        properties={"name": string(), "description": string(), "schema": obj()},
    ),
    "output": obj(required=["content"], properties={"content": ANY}),
    "summary": obj(
        required=["reason"],
        properties={
            "reason": string(enum=["completed", "error", "cancelled"]),
            "tool_calls": integer(minimum=0),
            "errors": integer(minimum=0),
            "duration_seconds": number(minimum=0),
        },
    ),
}

PROPERTIES: dict[str, Schema | bool] = {
    "spec": string(pattern=r"^agent-hooks/\d+\.\d+$"),
    "interception_point": ref("interception-point.schema.json"),
    "timestamp": string(format="date-time"),
    "sequence": integer(minimum=0),
    "agent": obj(
        required=["id", "framework"],
        properties={
            "id": string(minLength=1),
            "framework": string(pattern="^[a-z0-9_-]+$"),
            "name": string(),
            "version": string(),
        },
    ),
    "session": obj(
        required=["id"],
        properties={
            "id": string(minLength=1),
            "started_at": string(format="date-time"),
            "turn": integer(minimum=0),
        },
    ),
    "target": ANY,
    "agent_init": ref("#/$defs/agent_init"),
    "input": ref("#/$defs/input"),
    "model": ref("#/$defs/model"),
    "messages": ref("#/$defs/messages"),
    "request_id": string(),
    "response": ref("#/$defs/response"),
    "usage": ref("#/$defs/usage"),
    "tool_call": ref("#/$defs/tool_call"),
    "tool_result": ref("#/$defs/tool_result"),
    "tools": array(items=ref("#/$defs/tool_decl")),
    "output": ref("#/$defs/output"),
    "summary": ref("#/$defs/summary"),
    "trace": obj(properties={"trace_id": string(), "span_id": string()}),
    "tenant": obj(properties={"id": string(), "name": string()}),
    "actor": obj(
        properties={
            "id": string(),
            "kind": string(enum=["human", "service", "agent"]),
        }
    ),
    "budgets": obj(
        properties={
            "tool_call_count": number(),
            "token_count": number(),
            "elapsed_seconds": number(),
            "cost_usd": number(),
        }
    ),
    "extensions": obj(
        propertyNames=schema(pattern=EXTENSION_KEY),
        additionalProperties=True,
    ),
}

SCHEMA = document(
    "agent-context",
    title="Agent Hooks — agent context",
    description="Payload a host constructs at each interception point (AGENT-HOOKS-0.1 §4). "
    "required fields are always present; conditional fields are required per "
    "interception_point; optional fields are well-known; namespaced extensions live under "
    "extensions.",
    body=obj(
        required=CORE_REQUIRED,
        properties=PROPERTIES,
        allOf=[
            schema(
                if_=schema(properties={"interception_point": const(point)}),
                then=schema(required=members),
            )
            for point, members in CONDITIONAL.items()
        ],
        defs=DEFS,
    ),
)

#: The master file keeps the compact hand layout it was first committed in.
LAYOUT = Layout(
    expanded=frozenset({"/properties/spec", "/properties/tools"}),
    blank_after=frozenset({"/properties/target", "/properties/summary"}),
)


def per_point(point: str) -> Schema:
    """The closed variant for one interception point (§4.2)."""
    members = CONDITIONAL[point]
    defs = copy.deepcopy(DEFS)
    for name in members:
        if defs[name].get("type") == "object":
            defs[name]["additionalProperties"] = False
    return document(
        f"agent-context/{point}",
        title=f"Agent Hooks — agent context ({point})",
        description=f"Closed required+conditional schema for interception_point={point} "
        "(AGENT-HOOKS-0.1 §4.2). Used by the CTK for strict validation.",
        body=obj(
            required=CORE_REQUIRED + members,
            properties={**PROPERTIES, "interception_point": const(point)},
            defs=defs,
        ),
    )


PER_POINT = {point: per_point(point) for point in INTERCEPTION_POINTS}
