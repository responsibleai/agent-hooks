# Copyright (c) Microsoft. All rights reserved.

"""host-declaration-<version>.schema.json: the host declaration document (§7.7).

One builder produces every contract version, so 1.0 and 1.1 cannot drift
apart: 1.1 is 1.0 plus the two failure-posture members (§6.3.1).
"""

from __future__ import annotations

from .common import (
    COMPOSITION_PROFILES,
    DECLARATION_VERSION,
    EXTENSION_KEY,
    INTERCEPTION_POINTS,
    MODES,
    ON_APPROVAL,
    ON_DISAGREEMENT,
    ON_TRANSFORM_CONFLICT,
)
from .vocabulary import (
    Schema,
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

#: Grammar of a registered name: provider, resolver, redactor or binding id.
REFERENCE = "^[a-z][a-z0-9_-]{0,63}$"

#: The conformance capability vocabulary (§13.1) as the declaration states it.
CAPABILITIES = [
    "model_calls",
    "tool_calls",
    "parallel_tool_calls",
    "streaming",
    "multi_turn",
    "int64_json",
    "bigint_json",
    "incremental_output",
    "host_declaration",
]

ON_ERROR = ["deny", "continue"]

#: What each version after 1.0 adds, in the words the description carries.
ADDED = {
    "1.1": "1.1 adds two OPTIONAL members over 1.0: configuration.failure.on_error, the "
    "document default failure posture, and bindings[].on_error, the per-binding posture "
    "(§6.3.1); a document that uses neither means the same under both versions. A 1.0 "
    "document validates against host-declaration-1.0.schema.json. ",
}


def _knob_support(knob: str, values: list[str]) -> Schema:
    """A profile's entry in surface.profiles: the knob values the host supports."""
    return obj(
        additionalProperties=False,
        properties={
            knob: array(items=schema(enum=values), uniqueItems=True, minItems=1)
        },
    )


def _configuration(version: str) -> Schema:
    members = {
        "mode": string(enum=MODES, default="enforce", description="§8."),
        "composition": obj(
            additionalProperties=False,
            properties={
                "profile": string(
                    enum=COMPOSITION_PROFILES, default="sequential/first_deny"
                ),
                "on_approval": string(
                    enum=ON_APPROVAL,
                    description="Consulted by sequential/first_deny only; refused under any "
                    "other profile (§7.7.3).",
                ),
                "on_disagreement": string(
                    enum=ON_DISAGREEMENT,
                    description="Consulted by parallel/unanimous only.",
                ),
                "on_transform_conflict": string(
                    enum=ON_TRANSFORM_CONFLICT,
                    description="Consulted by parallel/strictest only.",
                ),
            },
            description="§7.2. A knob the declared profile does not consult is refused, never "
            "cleared; a consulted knob left unset takes the §7.2 default.",
        ),
        "identity_provider": schema(
            description='§10.1: "jcs-sha256" (the default), a registered custom provider name '
            "(^[a-z][a-z0-9_-]{0,63}$, never a jcs prefix), or null (identity-unbound).",
            anyOf=[
                const(None),
                const("jcs-sha256"),
                schema(
                    allOf=[
                        string(pattern=REFERENCE),
                        schema(not_=string(pattern="^jcs")),
                    ]
                ),
            ],
        ),
        "approval": obj(
            additionalProperties=False,
            properties={
                "resolver": schema(
                    description="§9. A registered approval resolver by reference, or null: "
                    "liftable denies stay denies.",
                    anyOf=[const(None), ref("#/$defs/reference")],
                ),
                "redactor": schema(
                    description="§9 redaction seam. A registered approval redactor by "
                    "reference, or null.",
                    anyOf=[const(None), ref("#/$defs/reference")],
                ),
            },
        ),
        "posture": obj(
            additionalProperties=False,
            properties={
                "tool_seam_host_error": string(
                    enum=["continue", "terminate"],
                    default="continue",
                    description="§13.1. Must equal the posture the host's code implements.",
                )
            },
        ),
    }
    if version != "1.0":
        members["failure"] = obj(
            additionalProperties=False,
            properties={
                "on_error": string(
                    enum=ON_ERROR,
                    default="deny",
                    description="§6.3.1. The document default every binding's on_error "
                    "inherits. deny keeps the §6.3 substituted deny; continue substitutes an "
                    "allow carrying host_warning:control_failed and records the cause in "
                    "substituted_for. Since 1.1.",
                )
            },
        )
    members.update(
        {
            "timeouts": obj(
                additionalProperties=False,
                properties={
                    "interceptor_ms": ref(
                        "#/$defs/timeout_ms",
                        description="§7 interceptor bound; default 5000. null means unbounded "
                        "and must be written out.",
                    ),
                    "approval_resolver_ms": ref(
                        "#/$defs/timeout_ms",
                        description="§9 resolver bound; defaults to the value of interceptor_ms.",
                    ),
                },
            ),
            "records": obj(
                additionalProperties=False,
                properties={
                    "max_buffered": integer(
                        nullable=True,
                        minimum=1,
                        maximum=9007199254740991,
                        description="In-memory record buffer bound; null (the default) is "
                        "unbounded. The maximum is 2^53 - 1 so the resolved document always "
                        "canonicalises (§4.4).",
                    )
                },
            ),
        }
    )
    return obj(
        additionalProperties=False,
        properties=members,
        description="Host configuration (§7.1). Every member is OPTIONAL; defaults are the "
        "values the specification already names and fail closed.",
    )


SURFACE = obj(
    additionalProperties=False,
    properties={
        "interception_points": array(
            items=ref("#/$defs/interception_point"),
            uniqueItems=True,
            minItems=4,
            maxItems=8,
            description="Points the host emits; always includes agent_startup, input, output "
            "and agent_shutdown (§3.2), and omits the model or tool points only in pairs.",
        ),
        "capabilities": array(items=ref("#/$defs/capability"), uniqueItems=True),
        "profiles": obj(
            additionalProperties=False,
            properties={
                "sequential/first_deny": _knob_support("on_approval", ON_APPROVAL),
                "sequential/run_all": obj(additionalProperties=False, properties={}),
                "parallel/strictest": _knob_support(
                    "on_transform_conflict", ON_TRANSFORM_CONFLICT
                ),
                "parallel/unanimous": _knob_support("on_disagreement", ON_DISAGREEMENT),
            },
            description="Profiles and the knob values supported under each (§13.1). Only the "
            "knobs a profile consults may appear; an absent knob member means the §7.2 "
            "default value only.",
        ),
        "buffered_output": boolean(
            default=True,
            description="§12.1a. false must be declared explicitly and requires "
            "exposure_bound.",
        ),
        "exposure_bound": string(
            minLength=1,
            maxLength=512,
            description="§12.1a. Present iff buffered_output is false.",
        ),
        "declaration_versions": array(
            items=string(pattern=DECLARATION_VERSION),
            uniqueItems=True,
            minItems=1,
            description="Contract versions the host accepts (§7.7.2); includes the "
            "document's own.",
        ),
    },
    if_=schema(
        properties={"buffered_output": const(False)},
        required=["buffered_output"],
    ),
    then=schema(required=["exposure_bound"]),
    else_=schema(not_=schema(required=["exposure_bound"])),
    description="The declared surface (§13.1) in file form. OPTIONAL: when absent the host's "
    "own code surface applies. Every stated member must be a subset of what the host's code "
    "reports; a document a conformance claim cites carries this block explicitly.",
)


def _binding(version: str) -> Schema:
    members = {
        "id": ref(
            "#/$defs/reference",
            description="Unique in the array; stamped on verdicts[].name (§10.3).",
        ),
        "kind": string(
            pattern=r"^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$",
            maxLength=128,
            description="A lookup key into the host's kind registry and nothing more: never a "
            "path, class name, URL or module the loader interprets. At least one dot, so "
            "every kind carries a namespace the host controls. The first segments "
            "agent_hooks and ctk are reserved. This specification defines no kinds.",
        ),
        "config": schema(
            description="Kind-specific; handed to the kind resolver unchanged. The loader "
            "interprets none of it; its one check here is the document-wide integer bound "
            "of §7.7.6 (no integer token above 2^53 - 1, so the resolved form "
            "canonicalises). Default {}."
        ),
        "at": array(
            items=ref("#/$defs/interception_point"),
            uniqueItems=True,
            minItems=1,
            description="Points this binding runs at, each in the surface. Default: every "
            "surface point.",
        ),
        "timeout_ms": ref(
            "#/$defs/timeout_ms",
            description="Per-binding bound. Default: configuration.timeouts.interceptor_ms; "
            "null is unbounded.",
        ),
    }
    if version != "1.0":
        members["on_error"] = string(
            enum=ON_ERROR,
            description="§6.3.1 failure posture for this binding: what the host does when the "
            "interceptor raises, times out or returns an invalid verdict. Default: "
            "configuration.failure.on_error. Since 1.1.",
        )
    return obj(additionalProperties=False, required=["id", "kind"], properties=members)


def build(version: str) -> Schema:
    """The schema of agent-hooks-declaration/<version>."""
    return document(
        f"host-declaration-{version}",
        title=f"Agent Hooks — host declaration document (agent-hooks-declaration/{version})",
        description="A host declaration document (AGENT-HOOKS-0.1 §7.7): one JSON object that "
        "fixes a host's configuration (§7.1, §8, §10.1, §13.1), its declared surface (§13.1) "
        "and its interceptor bindings. The document is a versioned contract of its own, "
        "separate from the wire version agent-hooks/0.1 and from package versions; this file "
        f"describes agent-hooks-declaration/{version}. {ADDED.get(version, '')}Every object "
        "is closed except bindings[].config and the values under extensions. This schema is "
        "self-contained so a settings validator can use it alone. Rules it cannot express "
        "(knob consistency, the §3.2 floor, surface against the host's code, registered "
        "names) live in the loader (§7.7.6).",
        body=obj(
            additionalProperties=False,
            required=["declaration", "bindings"],
            properties={
                "$schema": string(
                    description="Ignored by the loader; kept for editors."
                ),
                "declaration": string(
                    enum=[f"agent-hooks-declaration/{version}"],
                    description="The declaration contract version (§7.7.2). A loader refuses "
                    "any value outside the set it accepts with "
                    "declaration_error:version_unsupported. Major 0 is reserved for the "
                    "conformance kit.",
                ),
                "spec": string(
                    pattern=r"^agent-hooks/[0-9]+\.[0-9]+$",
                    description="OPTIONAL. The wire version the document was written for; the "
                    "loader's major, and a minor no greater than the loader's. Defaults to "
                    "the loader's SPEC_VERSION.",
                ),
                "id": string(
                    pattern="^[a-z0-9][a-z0-9._-]{0,63}$",
                    description="OPTIONAL. An operator label for logs. Never stamped on "
                    "records.",
                ),
                "host": obj(
                    additionalProperties=False,
                    required=["name"],
                    properties={
                        "name": string(
                            pattern="^[a-z0-9_-]{1,64}$",
                            description="Same grammar as agent.framework (§4.1).",
                        ),
                        "version": string(minLength=1, maxLength=64),
                    },
                    description="OPTIONAL and informative; never checked against code.",
                ),
                "configuration": _configuration(version),
                "surface": SURFACE,
                "bindings": array(
                    maxItems=256,
                    items=ref("#/$defs/binding"),
                    description="Ordered: array order is dispatch order. REQUIRED, so an "
                    "empty-deny host (zero bindings) is written down rather than arrived at "
                    "by omission. Binding ids are unique.",
                ),
                "extensions": obj(
                    propertyNames=schema(pattern=EXTENSION_KEY),
                    description="Host-specific extras, kept verbatim and never read by the "
                    "loader. Keys follow the §4.6 namespace rule; the §4.6 reserved "
                    "namespaces apply.",
                ),
            },
            defs={
                "interception_point": string(enum=INTERCEPTION_POINTS),
                "capability": string(
                    enum=CAPABILITIES,
                    description="The conformance capability vocabulary (§13.1, "
                    "conformance/vectors.schema.json) less buffered_output, which is the "
                    "boolean surface member, plus host_declaration.",
                ),
                "reference": string(pattern=REFERENCE),
                "timeout_ms": integer(nullable=True, minimum=1, maximum=3600000),
                "binding": _binding(version),
            },
        ),
    )


SCHEMA_1_0 = build("1.0")
SCHEMA_1_1 = build("1.1")
