# Copyright (c) Microsoft. All rights reserved.

"""interception-point.schema.json: the closed set of interception points (§3)."""

from __future__ import annotations

from .common import INTERCEPTION_POINTS
from .vocabulary import document, string

SCHEMA = document(
    "interception-point",
    title="Agent Hooks — interception point",
    description="The closed set of agent lifecycle interception points (AGENT-HOOKS-0.1 §3).",
    body=string(enum=INTERCEPTION_POINTS),
)
