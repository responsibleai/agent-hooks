#!/usr/bin/env python3
"""Generate conformance/golden/identity.json from the Rust core.

The fixtures exercise the corners that historically caused cross-SDK
divergence (RM-N01/RM-N02): number forms, negative zero, key ordering,
non-ASCII, optional/namespaced-field stripping, and every interception point's conditional shape.
Expected outputs are computed by the Rust core via the Python FFI
binding, so any language binding that agrees with these values agrees
with Rust.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(
    0, str(pathlib.Path(__file__).resolve().parents[1] / "sdk" / "python" / "python")
)
from agent_hooks import _core  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "conformance" / "golden" / "identity.json"


def ctx(ip: str, seq: int, extra: dict) -> dict:
    return {
        "spec": "agent-hooks/0.1",
        "interception_point": ip,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "sequence": seq,
        "agent": {"id": "agent-1", "framework": "reference"},
        "session": {"id": "sess-1"},
        **extra,
    }


FIXTURES: list[tuple[str, str, dict]] = [
    # (id, note, ctx)
    (
        "G-01-startup",
        "agent_startup baseline",
        ctx(
            "agent_startup",
            0,
            {
                "agent_init": {"tools_registered": ["a", "b"]},
                "target": {"tools_registered": ["a", "b"]},
            },
        ),
    ),
    (
        "G-02-input-unicode",
        "input with non-ASCII content and emoji",
        ctx(
            "input",
            1,
            {
                "input": {"content": "héllo 🌍", "role": "user"},
                "target": {"content": "héllo 🌍", "role": "user"},
            },
        ),
    ),
    (
        "G-03-pre-tool-numbers",
        "pre_tool_call with number edge cases in args",
        ctx(
            "pre_tool_call",
            4,
            {
                "tool_call": {
                    "id": "tc-1",
                    "name": "calc",
                    "args": {
                        "i": 1,
                        "f": 1.0,
                        "neg0": -0.0,
                        "big": 1e21,
                        "small": 1e-7,
                        "pi": 3.141592653589793,
                    },
                },
                "target": {
                    "i": 1,
                    "f": 1.0,
                    "neg0": -0.0,
                    "big": 1e21,
                    "small": 1e-7,
                    "pi": 3.141592653589793,
                },
            },
        ),
    ),
    (
        "G-04-key-order",
        "post_model_call with keys supplied in reverse order",
        ctx(
            "post_model_call",
            3,
            {
                "model": {"id": "m"},
                "response": {
                    "finish_reason": "stop",
                    "tool_calls": [],
                    "content": {"z": 1, "a": 2, "m": 3},
                },
                "target": {
                    "finish_reason": "stop",
                    "tool_calls": [],
                    "content": {"z": 1, "a": 2, "m": 3},
                },
            },
        ),
    ),
    (
        "G-05-l2-l3-stripped",
        "optional fields (trace, budgets, agent.name) and namespaced extensions MUST NOT affect identity",
        ctx(
            "input",
            1,
            {
                "input": {"content": "hi", "role": "user"},
                "target": {"content": "hi", "role": "user"},
                "agent": {
                    "id": "agent-1",
                    "framework": "reference",
                    "name": "IGNORED",
                    "version": "IGNORED",
                },
                "session": {"id": "sess-1", "started_at": "IGNORED", "turn": 99},
                "trace": {"trace_id": "IGNORED"},
                "budgets": {"tool_call_count": 999},
                "extensions": {"acs": {"anything": True}},
            },
        ),
    ),
    (
        "G-05b-l2-l3-baseline",
        "same required+conditional fields as G-05 without optional/namespaced ones; identity MUST equal G-05",
        ctx(
            "input",
            1,
            {
                "input": {"content": "hi", "role": "user"},
                "target": {"content": "hi", "role": "user"},
            },
        ),
    ),
    (
        "G-06-nested-array",
        "pre_model_call with nested message array",
        ctx(
            "pre_model_call",
            2,
            {
                "model": {"id": "gpt-x"},
                "messages": [
                    {"role": "system", "content": "a"},
                    {"role": "user", "content": {"parts": [1, 2, {"k": "v"}]}},
                ],
                "target": [
                    {"role": "system", "content": "a"},
                    {"role": "user", "content": {"parts": [1, 2, {"k": "v"}]}},
                ],
            },
        ),
    ),
    (
        "G-07-post-tool-null",
        "post_tool_call with null result value",
        ctx(
            "post_tool_call",
            5,
            {
                "tool_call": {"id": "tc-1", "name": "t", "args": {}},
                "tool_result": {"value": None, "is_error": False},
                "target": None,
            },
        ),
    ),
    (
        "G-08-output-escapes",
        "output with control chars requiring escape",
        ctx(
            "output",
            6,
            {
                "output": {"content": 'line1\nline2\t"q"\\end'},
                "target": {"content": 'line1\nline2\t"q"\\end'},
            },
        ),
    ),
    (
        "G-09-shutdown",
        "agent_shutdown baseline",
        ctx(
            "agent_shutdown",
            7,
            {
                "summary": {"reason": "completed"},
                "target": {"reason": "completed"},
            },
        ),
    ),
    (
        "G-10-empty-target",
        "pre_tool_call with empty args object",
        ctx(
            "pre_tool_call",
            4,
            {
                "tool_call": {"id": "tc-1", "name": "noop", "args": {}},
                "target": {},
            },
        ),
    ),
    (
        "G-11-utf16-key-order",
        "RFC 8785 sorts by UTF-16 code units: U+10000 (surrogate pair, "
        "first unit 0xD800) MUST sort before U+E000 despite the higher "
        "code point — the exact case where code-point sorters diverge. "
        "Empty key sorts first.",
        ctx(
            "pre_tool_call",
            8,
            {
                "tool_call": {
                    "id": "tc-2",
                    "name": "k",
                    "args": {
                        "": 1,
                        "\ue000": 2,
                        "\U00010000": 3,
                        "z": 4,
                        "\u00e9": 5,
                    },
                },
                "target": {
                    "": 1,
                    "\ue000": 2,
                    "\U00010000": 3,
                    "z": 4,
                    "\u00e9": 5,
                },
            },
        ),
    ),
    (
        "G-12-non-ascii-keys",
        "non-ASCII member names (accented, CJK, emoji) survive "
        "canonicalization unescaped and sort by UTF-16 units",
        ctx(
            "pre_tool_call",
            9,
            {
                "tool_call": {
                    "id": "tc-3",
                    "name": "k",
                    "args": {
                        "中文": 1,
                        "émoji🎯": 2,
                        "ascii": 3,
                    },
                },
                "target": {"中文": 1, "émoji🎯": 2, "ascii": 3},
            },
        ),
    ),
    (
        "G-13-int53-boundaries",
        "±(2^53−1) are the largest integral values inside the I-JSON "
        "domain (§10.2); one past either bound is rejected (see the "
        "negative fixtures)",
        ctx(
            "pre_tool_call",
            10,
            {
                "tool_call": {
                    "id": "tc-4",
                    "name": "k",
                    "args": {
                        "max": 9007199254740991,
                        "min": -9007199254740991,
                    },
                },
                "target": {"max": 9007199254740991, "min": -9007199254740991},
            },
        ),
    ),
    (
        "G-14-string-encoded-int64",
        "the §4.4 convention: 64-bit identifiers as decimal strings pass "
        "through byte-faithfully and never collide with numeric siblings",
        ctx(
            "pre_tool_call",
            11,
            {
                "tool_call": {
                    "id": "tc-5",
                    "name": "k",
                    "args": {
                        "id": "9223372036854775807",
                        "small": 42,
                    },
                },
                "target": {"id": "9223372036854775807", "small": 42},
            },
        ),
    ),
    (
        "G-15-rfc8785-numbers",
        "ECMA-262 Number::toString forms from the RFC 8785 test corpus "
        "(in-domain subset): trailing-zero drop, exponent thresholds, "
        "shortest round-trip",
        ctx(
            "pre_tool_call",
            12,
            {
                "tool_call": {
                    "id": "tc-6",
                    "name": "k",
                    "args": {
                        "a": 56.0,
                        "b": 0.000001,
                        "c": 1e-7,
                        "d": 333333333.33333329,
                        "e": 1e21,
                        "f": 9.999999999999997e22,
                        "g": 0.1,
                    },
                },
                "target": {
                    "a": 56.0,
                    "b": 0.000001,
                    "c": 1e-7,
                    "d": 333333333.33333329,
                    "e": 1e21,
                    "f": 9.999999999999997e22,
                    "g": 0.1,
                },
            },
        ),
    ),
]

# Out-of-domain contexts the jcs-sha256 provider MUST reject
# (§10.2 fail-closed). expect.error instead of canonical/identity.
NEGATIVE_FIXTURES: list[tuple[str, str, dict]] = [
    (
        "G-N01-integral-beyond-2-53",
        "2^53 itself is out of domain: canonicalization would round",
        ctx(
            "pre_tool_call",
            13,
            {
                "tool_call": {
                    "id": "tc-7",
                    "name": "k",
                    "args": {"id": 9007199254740992},
                },
                "target": {"id": 9007199254740992},
            },
        ),
    ),
    (
        "G-N02-missing-conditional",
        "pre_tool_call without tool_call fails §4.2 structural validation",
        ctx("pre_tool_call", 14, {"target": {}}),
    ),
]


def main() -> None:
    out = []
    for fid, note, c in FIXTURES:
        ctx_json = json.dumps(c, ensure_ascii=False)
        canon = _core.canonical_json(ctx_json)
        ident = _core.context_identity(ctx_json)
        out.append(
            {
                "id": fid,
                "note": note,
                "ctx": c,
                "expect": {"canonical_json": canon, "context_identity": ident},
            }
        )
    for fid, note, c in NEGATIVE_FIXTURES:
        ctx_json = json.dumps(c, ensure_ascii=False)
        try:
            _core.context_identity(ctx_json)
            raise SystemExit(f"{fid}: expected rejection, got an identity")
        except Exception:
            pass
        out.append(
            {
                "id": fid,
                "note": note,
                "ctx": c,
                "expect": {"error": "host_error:context_invalid"},
            }
        )
    # G-05 and G-05b MUST have identical identity (optional/namespaced stripped).
    g05 = next(f for f in out if f["id"] == "G-05-l2-l3-stripped")
    g05b = next(f for f in out if f["id"] == "G-05b-l2-l3-baseline")
    assert g05["expect"]["context_identity"] == g05b["expect"]["context_identity"], (
        "optional/namespaced stripping is broken in the core"
    )
    # Independent RFC 8785 §3.2.3 oracle: UTF-16 unit order puts the
    # surrogate-pair key (U+10000, first unit 0xD800) BEFORE U+E000-
    # class keys and after plain BMP text. Hand-derived, not core-
    # derived — this is the case where code-point sorters get it wrong.
    g11 = next(f for f in out if f["id"] == "G-11-utf16-key-order")
    canon = g11["expect"]["canonical_json"]
    # Expected UTF-16-unit order: "" < "z"(0x7A) < "é"(0xE9)
    # < U+10000 (0xD800 0xDC00) < U+E000 (0xE000). A code-point sorter
    # would put U+E000 before U+10000 — the divergence this pins.
    keys = ['"":1', '"z":4', '"\u00e9":5', '"\U00010000":3', '"\ue000":2']
    order = [canon.index(k) for k in keys]
    assert order == sorted(order), (
        f"G-11 key order violates RFC 8785 UTF-16 sorting: {canon!r}"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "spec": "agent-hooks/0.1",
                "generator": "scripts/gen-golden-identity.py via Rust core",
                "fixtures": out,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({len(out)} fixtures)")


if __name__ == "__main__":
    main()
