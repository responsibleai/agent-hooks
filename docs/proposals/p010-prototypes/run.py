# Copyright (c) Microsoft. All rights reserved.

"""Run every measurement and print the tables as Markdown.

    python3 run.py

Standard library only. Run under an environment that has the
``agent-hooks-sdk`` package installed to cross-check canonical bytes against
the Rust core.
"""

from __future__ import annotations

import copy
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import candidates as cd  # noqa: E402
import jcs  # noqa: E402
import neutral as nz  # noqa: E402
import paths  # noqa: E402
from fixtures import FIXTURES, PROVIDER_FORMATS, fixture, response_fixture  # noqa: E402

SHORT = {
    "openai.chat": "chat",
    "openai.responses": "responses",
    "anthropic.messages": "anthropic",
}


def table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for r in rows:
        lines.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(lines)


def descriptor(line: str) -> str:
    """`$.a.b[2] thinking missing` -> `thinking`; `$.a.cache_control missing` -> `cache_control`."""
    head, _, verb = line.rpartition(" ")
    words = head.split(" ")
    if len(words) == 2:
        return words[1]
    return words[0].rsplit(".", 1)[-1].split("[")[0]


def summarize(paths_: list[str]) -> str:
    if not paths_:
        return "none"
    return f"{len(paths_)}: " + ", ".join(sorted({descriptor(p) for p in paths_}))


def section_round_trip() -> None:
    print("## Round-trip loss by candidate\n")
    print(
        "Each cell: differences between the provider request and provider -> target -> provider, after normalizing representation-only choices (string versus single text part, default-valued members).\n"
    )
    rows = []
    for name in FIXTURES:
        for fmt in PROVIDER_FORMATS:
            req = fixture(name, fmt)
            rows.append(
                [name, SHORT[fmt]]
                + [summarize(cd.loss(fmt, req, c)) for c in ("A", "B", "B-", "C")]
            )
    print(
        table(
            [
                "fixture",
                "source",
                "A (chat as the shape)",
                "B (neutral + ext)",
                "B- (neutral, ext stripped)",
                "C (format + raw + summary)",
            ],
            rows,
        )
    )
    print()
    print("Detail of the losses:\n")
    for name in FIXTURES:
        for fmt in PROVIDER_FORMATS:
            req = fixture(name, fmt)
            for c in ("A", "B-"):
                lost = cd.loss(fmt, req, c)
                if lost:
                    print(f"- {name} / {SHORT[fmt]} / {c}: " + "; ".join(lost))
    print()


def section_sizes() -> None:
    print("## Size of the target under canonical JSON (bytes)\n")
    print(
        "The identity provider hashes the required and conditional fields whole, so the target's canonical size is the identity preimage growth per emission. D uses the agent-framework style emission; a pass-through host's D equals the raw column.\n"
    )
    rows = []
    checked: list[Any] = []
    for name in FIXTURES:
        for fmt in PROVIDER_FORMATS:
            req = fixture(name, fmt)
            raw = cd.conversation(fmt, req)
            a = cd.target_a(fmt, req)
            b = cd.target_b(fmt, req, keep_ext=True)
            b_min = cd.target_b(fmt, req, keep_ext=False)
            c = cd.target_c(fmt, req)
            d = cd.target_d(fmt, fixture(name, "current"))
            checked += [raw, a, b, b_min, c, d]
            rows.append(
                [
                    name,
                    SHORT[fmt],
                    jcs.size(raw),
                    jcs.size(a),
                    jcs.size(b),
                    jcs.size(b_min),
                    jcs.size(c),
                    jcs.size(d),
                ]
            )
    print(
        table(
            [
                "fixture",
                "source",
                "raw provider",
                "A",
                "B (with ext)",
                "B- (neutral only)",
                "C",
                "D (current + label)",
            ],
            rows,
        )
    )
    print()
    print(jcs.cross_check(checked))
    print()
    print("### Growth with an inline image\n")
    base64_bytes = 133_336  # about 100 KiB of image data after base64
    data = "A" * base64_bytes
    rows = []
    for fmt in PROVIDER_FORMATS:
        req = fixture("chart", fmt)
        if fmt == "openai.chat":
            req["messages"][1]["content"][1]["image_url"]["url"] = (
                f"data:image/png;base64,{data}"
            )
        elif fmt == "openai.responses":
            req["input"][0]["content"][1]["image_url"] = f"data:image/png;base64,{data}"
        else:
            req["messages"][0]["content"][0]["source"] = {
                "type": "base64",
                "media_type": "image/png",
                "data": data,
            }
        raw = cd.conversation(fmt, req)
        a = cd.target_a(fmt, req)
        b = cd.target_b(fmt, req, keep_ext=False)
        c = cd.target_c(fmt, req)
        b_digest = copy.deepcopy(b)
        for m in b_digest["messages"]:
            for p in m["content"]:
                if p["type"] == "media" and p["source"]["type"] == "base64":
                    p["source"] = {
                        "type": "digest",
                        "sha256": jcs.digest(p["source"]["data"])[7:],
                        "bytes": len(p["source"]["data"]),
                    }
        rows.append(
            [
                SHORT[fmt],
                jcs.size(raw),
                jcs.size(a),
                jcs.size(b),
                jcs.size(c),
                jcs.size(b_digest),
            ]
        )
    print(
        table(
            ["source", "raw provider", "A", "B-", "C", "B- with media as digest"], rows
        )
    )
    print()


def section_identity_stability() -> None:
    print("## Identity stability under a provider-only change\n")
    print(
        "Toggle the Anthropic `cache_control` marker on the system block of the chart fixture and compare the canonical digest of each target. A marker that moves between requests changes nothing the model reads.\n"
    )
    base = fixture("chart", "anthropic.messages")
    moved = copy.deepcopy(base)
    del moved["system"][0]["cache_control"]
    rows = []
    for label, fn in (
        ("A", lambda r: cd.target_a("anthropic.messages", r)),
        ("B (with ext)", lambda r: cd.target_b("anthropic.messages", r, True)),
        ("B- (neutral only)", lambda r: cd.target_b("anthropic.messages", r, False)),
        ("C", lambda r: cd.target_c("anthropic.messages", r)),
    ):
        rows.append(
            [
                label,
                "changed"
                if jcs.digest(fn(base)) != jcs.digest(fn(moved))
                else "unchanged",
            ]
        )
    print(table(["target", "digest after the marker moves"], rows))
    print()


def section_transforms() -> None:
    print("## Transform expressiveness\n")
    print(
        "One `{path, value}` transform rooted at `$target` per edit. `exact` means the write-back equals the same edit made natively on the provider request; `collateral loss` lists what else changed.\n"
    )
    edits = (
        ("redact", "bank"),
        ("redact", "chart"),
        ("drop_tool", "weather"),
        ("system", "bank"),
        ("system", "chart"),
    )
    for candidate in ("A", "B", "C"):
        rows = []
        shapes: set[str] = set()
        for edit, name in edits:
            for fmt in PROVIDER_FORMATS:
                r = paths.check(candidate, edit, fmt, fixture(name, fmt))
                if r["path"] != "-":
                    shapes.add(r["path"])
                rows.append(
                    [
                        edit,
                        name,
                        SHORT[fmt],
                        f"`{r['path']}`" if r["path"] != "-" else "-",
                        r["outcome"]
                        + (
                            " (" + summarize(r["collateral"]) + ")"
                            if r["collateral"]
                            else ""
                        ),
                    ]
                )
        print(
            f"### Candidate {candidate} ({len(shapes)} distinct paths across the three sources)\n"
        )
        print(table(["edit", "fixture", "source", "path", "write-back"], rows))
        print()
    print(
        "Candidate D: the paths depend on the host's own shape; a policy cannot be written once. Under the current specification `tools` is outside `target` at `pre_model_call` for every candidate, so dropping a tool needs the target widened to the request object.\n"
    )


def section_responses() -> None:
    print("## post_model_call: provider responses through the neutral response\n")
    rows = []
    for name in ("weather", "chart"):
        for fmt in PROVIDER_FORMATS:
            out, dropped = nz.response_to_neutral(fmt, response_fixture(name, fmt))
            parts = ", ".join(p["type"] for p in out["content"]) or "-"
            rows.append(
                [
                    name,
                    SHORT[fmt],
                    parts,
                    len(out["tool_calls"]),
                    out["finish_reason"],
                    ", ".join(sorted(set(dropped))) or "none",
                ]
            )
    print(
        table(
            [
                "fixture",
                "source",
                "content parts",
                "tool calls",
                "finish_reason",
                "members left for ext",
            ],
            rows,
        )
    )
    print()


def section_current_shape() -> None:
    print("## What hosts emit today for the same conversation\n")
    rows = []
    for name in FIXTURES:
        cur = fixture(name, "current")
        kinds = sorted(
            {
                p.get("type", "string")
                for m in cur["messages"]
                for p in (
                    m["content"]
                    if isinstance(m["content"], list)
                    else [{"type": "string"}]
                )
            }
        )
        rows.append(
            [
                name,
                "agent-framework style",
                ", ".join(kinds),
                "tool calls as `function_call` parts; results as `function_result` parts in a `tool` message",
            ]
        )
        rows.append(
            [
                name,
                "pass-through",
                "the provider's own part types",
                "identical to the raw provider column",
            ]
        )
    print(
        table(
            [
                "fixture",
                "host style",
                "content part types seen by a policy",
                "tool calls",
            ],
            rows,
        )
    )
    print()


def main() -> None:
    print("# P-010 prototype results\n")
    print(
        "Fixtures: `bank` (system, user, assistant, user; text only), `weather` (a tool-call round trip with two declared tools), `chart` (an image in the user turn, reasoning in the assistant turn, a cache marker on the system prompt).\n"
    )
    section_round_trip()
    section_sizes()
    section_identity_stability()
    section_transforms()
    section_responses()
    section_current_shape()


if __name__ == "__main__":
    main()
