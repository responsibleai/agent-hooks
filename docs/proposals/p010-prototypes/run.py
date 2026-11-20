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
import policies as pol  # noqa: E402
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
        ("edit_arg", "transfer"),
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


def section_ergonomics() -> None:
    print("## Policy ergonomics across seven target shapes\n")
    print(
        "The same three policy tasks written against each shape: redact a secret in the latest user turn, "
        "block when any tool result contains the pattern, cap the system prompt. Lines count the three "
        "format-specific locators a policy author writes; path shapes are the distinct section 5.2 paths "
        "(indices replaced by `*`) needed across the three fixtures and three sources; write-back is exact "
        "when the restored provider request equals the same edit made natively; loss and size sum over "
        "the nine fixture and source pairs.\n"
    )
    rows = []
    shapes_report: dict[str, dict[str, set[str]]] = {}
    for target in pol.TARGETS:
        user_fn, tool_fn, sys_fn = pol.LOCATORS[target]
        lines = (
            pol.logic_lines(user_fn),
            pol.logic_lines(tool_fn),
            pol.logic_lines(sys_fn),
        )
        user_paths: set[str] = set()
        tool_paths: set[str] = set()
        sys_paths: set[str] = set()
        redact_exact = cap_exact = 0
        pii_hits = pii_false = 0
        lossy_pairs = 0
        loss_kinds: set[str] = set()
        size = 0
        for name in FIXTURES:
            for src in PROVIDER_FORMATS:
                req = fixture(name, src)
                built = pol.build(target, src, req)
                view = pol._view(target, built)
                user_paths |= {pol.shape(p) for _, p, _ in user_fn(view)}
                tool_paths |= {pol.shape(p) for _, p, _ in tool_fn(view)}
                sys_paths |= {pol.shape(p) for _, p, _ in sys_fn(view)}
                redact_exact += pol.task_redact(target, src, req)["exact"]
                cap_exact += pol.task_cap_system(target, src, req)["exact"]
                pii_false += pol.task_block_pii(target, src, req)["deny"]
                if name == "weather":
                    pii_hits += pol.task_block_pii(
                        target, src, pol.with_pii_tool_result(src, req)
                    )["deny"]
                lost = pol.round_trip_loss(target, src, req)
                lossy_pairs += bool(lost)
                loss_kinds |= {descriptor(x) for x in lost}
                size += jcs.size(built)
        shapes_report[target] = {
            "user": user_paths,
            "tool": tool_paths,
            "system": sys_paths,
        }
        rows.append(
            [
                target,
                pol.ARGS_KIND[target],
                f"{lines[0]}+{lines[1]}+{lines[2]}={sum(lines)}",
                len(user_paths),
                len(tool_paths),
                len(sys_paths),
                f"{redact_exact}/9",
                f"{pii_hits}/3, {pii_false} false",
                f"{cap_exact}/9",
                f"{lossy_pairs}/9"
                + (f" ({', '.join(sorted(loss_kinds))})" if loss_kinds else ""),
                size,
            ]
        )
    print(
        table(
            [
                "target shape",
                "tool args",
                "locator lines (user+tool+system)",
                "user-text paths",
                "tool-result paths",
                "system paths",
                "redact exact",
                "PII deny (leaked, clean)",
                "cap exact",
                "lossy pairs",
                "size (9 pairs)",
            ],
            rows,
        )
    )
    print()
    print("Path shapes a policy must know (indices as `*`):\n")
    for target, groups in shapes_report.items():
        print(f"- {target}:")
        for label in ("user", "tool", "system"):
            print(f"  - {label}: " + "; ".join(f"`{p}`" for p in sorted(groups[label])))
    print()


def _strip_by_name(value: Any) -> Any:
    """The defective rule: drop every member named ext, wherever it sits."""
    if isinstance(value, dict):
        return {k: _strip_by_name(v) for k, v in value.items() if k != "ext"}
    if isinstance(value, list):
        return [_strip_by_name(v) for v in value]
    return value


def section_identity_positional() -> None:
    print("## Identity exclusion by slot, not by member name\n")
    print(
        "The `transfer` fixture carries a member named `ext` inside the tool arguments. Two requests that differ "
        "only in that member must have different identities; two that differ only in a protocol `ext` slot "
        "(a cache marker as residue) must not. Digests are over the neutral target without protocol residue.\n"
    )
    base = fixture("transfer", "openai.chat")
    changed = fixture("transfer", "openai.chat")
    changed["messages"][2]["tool_calls"][0]["function"]["arguments"] = (
        '{ "amount": 100, "to": "brokerage", "ext": { "memo": "fees" } }'
    )
    n_base = cd.target_b("openai.chat", base)
    n_changed = cd.target_b("openai.chat", changed)
    anth = fixture("transfer", "anthropic.messages")
    anth_marked = fixture("transfer", "anthropic.messages")
    anth_marked["system"] = [
        {"type": "text", "text": anth["system"], "cache_control": {"type": "ephemeral"}}
    ]
    a_base = cd.target_b("anthropic.messages", anth)
    a_marked = cd.target_b("anthropic.messages", anth_marked)
    rows = [
        [
            "args.ext.memo differs, exclusion by member name (defect)",
            "identical"
            if jcs.digest(_strip_by_name(n_base))
            == jcs.digest(_strip_by_name(n_changed))
            else "different",
        ],
        [
            "args.ext.memo differs, exclusion by slot",
            "identical"
            if jcs.digest(nz.strip_ext(n_base)) == jcs.digest(nz.strip_ext(n_changed))
            else "different",
        ],
        [
            "cache marker in a protocol ext slot differs, exclusion by slot",
            "identical"
            if jcs.digest(nz.strip_ext(a_base)) == jcs.digest(nz.strip_ext(a_marked))
            else "different",
        ],
    ]
    print(table(["case", "digests"], rows))
    print()
    print(
        jcs.cross_check(
            [
                nz.strip_ext(n_base),
                nz.strip_ext(n_changed),
                nz.strip_ext(a_base),
                nz.strip_ext(a_marked),
            ]
        )
    )
    print()
    print(
        "Argument edit round trip (the `transfer` fixture, amount 100 to 1, through each candidate):\n"
    )
    rows = []
    for candidate in ("A", "B", "C"):
        for fmt in PROVIDER_FORMATS:
            r = paths.check(candidate, "edit_arg", fmt, fixture("transfer", fmt))
            rows.append(
                [
                    candidate,
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
    print(table(["candidate", "source", "path", "write-back"], rows))
    print()


def main() -> None:
    print("# P-010 prototype results\n")
    print(
        "Fixtures: `bank` (system, user, assistant, user; text only), `weather` (a tool-call round trip with two declared tools), `chart` (an image in the user turn, reasoning in the assistant turn, a cache marker on the system prompt).\n"
    )
    section_round_trip()
    section_sizes()
    section_identity_stability()
    section_identity_positional()
    section_transforms()
    section_responses()
    section_current_shape()
    section_ergonomics()


if __name__ == "__main__":
    main()
