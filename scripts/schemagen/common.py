# Copyright (c) Microsoft. All rights reserved.

"""Values that more than one schema states and that must agree between them."""

from __future__ import annotations

#: The closed set of interception points (AGENT-HOOKS-0.1 §3), in lifecycle order.
INTERCEPTION_POINTS = [
    "agent_startup",
    "input",
    "pre_model_call",
    "post_model_call",
    "pre_tool_call",
    "post_tool_call",
    "output",
    "agent_shutdown",
]

#: The three verdict decisions (§5).
DECISIONS = ["allow", "deny", "transform"]

#: Enforcement modes (§8).
MODES = ["enforce", "evaluate_only"]

#: Composition profiles (§7.1) and the values of the knobs they consult (§7.2).
COMPOSITION_PROFILES = [
    "sequential/first_deny",
    "sequential/run_all",
    "parallel/strictest",
    "parallel/unanimous",
]
ON_APPROVAL = ["stop", "resume"]
ON_DISAGREEMENT = ["deny", "approval"]
ON_TRANSFORM_CONFLICT = ["deny", "approval"]

#: Grammar of a namespaced extensions key (§4.6).
EXTENSION_KEY = "^[a-z][a-z0-9_]*$"

#: Grammar of a declaration contract version string (§7.7.2).
DECLARATION_VERSION = r"^agent-hooks-declaration/[0-9]+\.[0-9]+$"
