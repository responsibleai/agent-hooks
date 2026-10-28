# Copyright (c) Microsoft. All rights reserved.

"""A resolver for the transform path grammar of AGENT-HOOKS-0.1 section 5.2
(``$target`` root, dot-member, bracket-index, bracket-member) and the three
edits the proposal measures:

1. redact a string inside a user message,
2. drop a tool definition,
3. replace the system prompt.

For each candidate target the edit is written as one ``{path, value}``
transform, applied, written back to the provider request, and compared with
the same edit made natively on the provider request.
"""

from __future__ import annotations

import copy
import re
from typing import Any

import candidates as cd
import neutral as nz

CHAT, RESPONSES, ANTHROPIC = nz.CHAT, nz.RESPONSES, nz.ANTHROPIC

_SEGMENT = re.compile(r'\.([A-Za-z0-9_-]+)|\[(\d+)\]|\["([A-Za-z0-9_-]+)"\]')


def parse(path: str) -> list[str | int]:
    if not path.startswith("$target"):
        raise ValueError("path must be rooted at $target")
    rest = path[len("$target") :]
    segments: list[str | int] = []
    pos = 0
    while pos < len(rest):
        m = _SEGMENT.match(rest, pos)
        if not m:
            raise ValueError(f"bad segment at {rest[pos:]!r}")
        if m.group(2) is not None:
            segments.append(int(m.group(2)))
        else:
            segments.append(m.group(1) or m.group(3))
        pos = m.end()
    return segments


def apply(target: Any, path: str, value: Any) -> Any:
    """Return a copy of ``target`` with the location at ``path`` replaced."""
    target = copy.deepcopy(target)
    segments = parse(path)
    if not segments:
        return copy.deepcopy(value)
    node = target
    for seg in segments[:-1]:
        node = node[seg]
    node[segments[-1]] = copy.deepcopy(value)
    return target


class NotExpressible(Exception):
    pass


REDACTED = "[redacted]"
NEW_SYSTEM = (
    "You are a careful assistant. Never move money without a confirmed balance."
)


# --- the same edits made natively on each provider request ---------------------------


def _first_user_index(messages: list[dict[str, Any]]) -> int:
    return next(i for i, m in enumerate(messages) if m["role"] == "user")


def native_redact(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    req = copy.deepcopy(request)
    items = req["messages"] if fmt != RESPONSES else req["input"]
    i = _first_user_index(items)
    content = items[i]["content"]
    if isinstance(content, str):
        items[i]["content"] = REDACTED
    else:
        for part in content:
            if part.get("type") in ("text", "input_text"):
                part["text"] = REDACTED
                break
    return req


def native_drop_tool(fmt: str, request: dict[str, Any], name: str) -> dict[str, Any]:
    req = copy.deepcopy(request)
    if fmt == CHAT:
        req["tools"] = [t for t in req["tools"] if t["function"]["name"] != name]
    else:
        req["tools"] = [t for t in req["tools"] if t["name"] != name]
    return req


def native_system(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    req = copy.deepcopy(request)
    if fmt == CHAT:
        req["messages"][0]["content"] = NEW_SYSTEM
    elif fmt == RESPONSES:
        req["instructions"] = NEW_SYSTEM
    elif isinstance(req["system"], str):
        req["system"] = NEW_SYSTEM
    else:
        req["system"][0]["text"] = NEW_SYSTEM
    return req


# --- the transform a policy author writes against each candidate --------------------


def _text_part_index(parts: list[dict[str, Any]], text_type: str = "text") -> int:
    return next(j for j, p in enumerate(parts) if p.get("type") == text_type)


def transform_for(
    candidate: str,
    edit: str,
    fmt: str,
    target: dict[str, Any],
    tool_name: str = "send_email",
) -> tuple[str, Any]:
    """Return (path, value) for the edit, or raise NotExpressible."""
    if candidate == "A":
        msgs = target["messages"]
        if edit == "redact":
            i = _first_user_index(msgs)
            if isinstance(msgs[i]["content"], str):
                return f"$target.messages[{i}].content", REDACTED
            j = _text_part_index(msgs[i]["content"])
            return f"$target.messages[{i}].content[{j}].text", REDACTED
        if edit == "drop_tool":
            if "tools" not in target:
                raise NotExpressible("tools are outside the target")
            return "$target.tools", [
                t for t in target["tools"] if t["function"]["name"] != tool_name
            ]
        if edit == "system":
            if msgs[0]["role"] != "system":
                raise NotExpressible("no leading system message")
            return "$target.messages[0].content", NEW_SYSTEM
    if candidate == "B":
        msgs = target["messages"]
        if edit == "redact":
            i = _first_user_index(msgs)
            j = _text_part_index(msgs[i]["content"])
            return f"$target.messages[{i}].content[{j}].text", REDACTED
        if edit == "drop_tool":
            if "tools" not in target:
                raise NotExpressible("tools are outside the target")
            return "$target.tools", [
                t for t in target["tools"] if t["name"] != tool_name
            ]
        if edit == "system":
            if msgs[0]["role"] != "system":
                raise NotExpressible("no leading system message")
            return "$target.messages[0].content[0].text", NEW_SYSTEM
    if candidate == "C":
        raw = target["raw"]
        if edit == "redact":
            if fmt == RESPONSES:
                i = _first_user_index(raw["input"])
                content = raw["input"][i]["content"]
                if isinstance(content, str):
                    return f"$target.raw.input[{i}].content", REDACTED
                j = _text_part_index(content, "input_text")
                return f"$target.raw.input[{i}].content[{j}].text", REDACTED
            i = _first_user_index(raw["messages"])
            content = raw["messages"][i]["content"]
            if isinstance(content, str):
                return f"$target.raw.messages[{i}].content", REDACTED
            j = _text_part_index(content)
            return f"$target.raw.messages[{i}].content[{j}].text", REDACTED
        if edit == "drop_tool":
            if "tools" not in raw:
                raise NotExpressible("no tools")
            if fmt == CHAT:
                return "$target.raw.tools", [
                    t for t in raw["tools"] if t["function"]["name"] != tool_name
                ]
            return "$target.raw.tools", [
                t for t in raw["tools"] if t["name"] != tool_name
            ]
        if edit == "system":
            if fmt == CHAT:
                return "$target.raw.messages[0].content", NEW_SYSTEM
            if fmt == RESPONSES:
                return "$target.raw.instructions", NEW_SYSTEM
            if isinstance(raw["system"], str):
                return "$target.raw.system", NEW_SYSTEM
            return "$target.raw.system[0].text", NEW_SYSTEM
    raise NotExpressible(f"{candidate}/{edit}")


def check(
    candidate: str, edit: str, fmt: str, request: dict[str, Any]
) -> dict[str, Any]:
    """Apply the edit through the candidate and compare the write-back with the
    native edit. Returns path, outcome and collateral differences."""
    residue = {k: v for k, v in request.items() if k not in cd.CONVERSATION_KEYS[fmt]}
    if candidate == "A":
        target = cd.target_a(fmt, request)
        restore = cd.restore_a
    elif candidate == "B":
        target = cd.target_b(fmt, request)
        restore = cd.restore_b
    else:
        target = cd.target_c(fmt, request)
        restore = cd.restore_c
    expected = {"redact": native_redact, "system": native_system}.get(edit)
    expected_req = (
        expected(fmt, request)
        if expected
        else native_drop_tool(fmt, request, "send_email")
    )
    try:
        path, value = transform_for(candidate, edit, fmt, target)
    except (NotExpressible, StopIteration) as exc:
        return {"path": "-", "outcome": f"not expressible ({exc})", "collateral": []}
    edited = apply(target, path, value)
    restored = restore(fmt, edited, residue)
    collateral = cd.diff(cd.normalize(fmt, expected_req), cd.normalize(fmt, restored))
    stale = ""
    if candidate == "C":
        fresh = cd.target_c(fmt, restored)["summary"]
        stale = "; summary stale" if fresh != edited["summary"] else ""
    outcome = ("exact" if not collateral else "collateral loss") + stale
    return {"path": path, "outcome": outcome, "collateral": collateral}
