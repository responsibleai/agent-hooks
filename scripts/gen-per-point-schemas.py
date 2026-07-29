#!/usr/bin/env python3
"""Generate spec/schema/agent-context/<interception_point>.schema.json from the master.

Each per-point schema is a closed (additionalProperties: false on the conditional
payload object) variant of agent-context.schema.json restricted to one
interception_point value, used by the CTK for strict validation.
"""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MASTER = ROOT / "spec" / "schema" / "agent-context.schema.json"
OUT = ROOT / "spec" / "schema" / "agent-context"

# interception_point -> (extra conditional required fields beyond the required core, payload $defs to close)
CONDITIONAL: dict[str, tuple[list[str], list[str]]] = {
    "agent_startup": (["agent_init"], ["agent_init"]),
    "input": (["input"], ["input"]),
    "pre_model_call": (["model", "messages"], ["model", "messages"]),
    "post_model_call": (["model", "response"], ["model", "response"]),
    "pre_tool_call": (["tool_call"], ["tool_call"]),
    "post_tool_call": (["tool_call", "tool_result"], ["tool_call", "tool_result"]),
    "output": (["output"], ["output"]),
    "agent_shutdown": (["summary"], ["summary"]),
}

CORE_REQUIRED = [
    "spec",
    "interception_point",
    "timestamp",
    "sequence",
    "agent",
    "session",
    "target",
]


def main() -> None:
    master = json.loads(MASTER.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for hp, (extra_req, close_defs) in CONDITIONAL.items():
        # Start from master $defs but close the conditional payload objects.
        defs = json.loads(json.dumps(master["$defs"]))  # deep copy
        for d in close_defs:
            if d in defs and defs[d].get("type") == "object":
                defs[d]["additionalProperties"] = False
        schema = {
            "$id": f"https://responsibleai.github.io/agent-hooks/schema/v0.1/agent-context/{hp}.schema.json",
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": f"Agent Hooks — agent context ({hp})",
            "description": (
                f"Closed required+conditional schema for interception_point={hp} "
                f"(AGENT-HOOKS-0.1 §4.2). Used by the CTK for strict validation."
            ),
            "type": "object",
            "required": CORE_REQUIRED + extra_req,
            "properties": {
                **{k: master["properties"][k] for k in master["properties"]},
                "interception_point": {"const": hp},
            },
            "$defs": defs,
        }
        out = OUT / f"{hp}.schema.json"
        out.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
