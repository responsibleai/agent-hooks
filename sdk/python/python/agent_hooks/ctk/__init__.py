# Copyright (c) Microsoft. All rights reserved.

"""Conformance Test Kit (§13)."""

from __future__ import annotations

from agent_hooks.ctk.harness import (
    Capability,
    Harness,
    LoadRecord,
    RunOutcome,
    RunRecord,
    Scenario,
)
from agent_hooks.ctk.runner import (
    VectorResult,
    builder_from_value,
    load_vectors,
    prove_paths,
    run_vector,
    run_vectors,
)
from agent_hooks.ctk.scripted import (
    RecordingInterceptor,
    ScriptedInterceptor,
    ScriptedManagedInterceptor,
    ScriptedResolver,
    redact_paths,
)

__all__ = [
    "Capability",
    "Harness",
    "LoadRecord",
    "RecordingInterceptor",
    "RunOutcome",
    "RunRecord",
    "Scenario",
    "ScriptedInterceptor",
    "ScriptedManagedInterceptor",
    "ScriptedResolver",
    "VectorResult",
    "builder_from_value",
    "load_vectors",
    "prove_paths",
    "redact_paths",
    "run_vector",
    "run_vectors",
]
