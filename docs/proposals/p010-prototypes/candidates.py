# Copyright (c) Microsoft. All rights reserved.

"""The four candidate targets for ``pre_model_call``, built from one provider
request, plus a JSON diff used to measure what each loses.

A: OpenAI chat-completions messages as the one prescribed shape.
B: the neutral shape of ``neutral.py`` (with ``ext`` residue, or stripped).
C: a tagged union: ``format`` plus the raw provider conversation plus a
   neutral summary (B stripped of ``ext``).
D: the host's current loose shape plus a ``format`` label.
"""

from __future__ import annotations

import copy
from typing import Any

import neutral as nz

CHAT, RESPONSES, ANTHROPIC = nz.CHAT, nz.RESPONSES, nz.ANTHROPIC

# The members of a provider request that make up the conversation the model
# sees (as opposed to model id and sampling options).
CONVERSATION_KEYS = {
    CHAT: ("messages", "tools"),
    RESPONSES: ("instructions", "input", "tools"),
    ANTHROPIC: ("system", "messages", "tools"),
}


def conversation(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    return {
        k: copy.deepcopy(request[k]) for k in CONVERSATION_KEYS[fmt] if k in request
    }


# --- candidate targets -------------------------------------------------------------


def target_a(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    """Chat-completions ``{messages, tools?}`` with no extension slot. A chat
    host sends its payload as is; other hosts project into it."""
    if fmt == CHAT:
        return conversation(fmt, request)
    n, _ = nz.to_neutral(fmt, request)
    chat = nz.neutral_to_chat(nz.strip_ext(n), {})
    return {k: chat[k] for k in ("messages", "tools") if k in chat}


def restore_a(
    fmt: str, target: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    if fmt == CHAT:
        return {**request_residue, **copy.deepcopy(target)}
    n, _ = nz.chat_to_neutral(target)
    return nz.from_neutral(fmt, nz.strip_ext(n), request_residue)


def target_b(
    fmt: str, request: dict[str, Any], keep_ext: bool = True
) -> dict[str, Any]:
    n, _ = nz.to_neutral(fmt, request)
    return n if keep_ext else nz.strip_ext(n)


def restore_b(
    fmt: str, target: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    return nz.from_neutral(fmt, target, request_residue)


def target_c(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    n, _ = nz.to_neutral(fmt, request)
    return {
        "format": fmt,
        "raw": conversation(fmt, request),
        "summary": nz.strip_ext({k: v for k, v in n.items() if k != "format"}),
    }


def restore_c(
    fmt: str, target: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    return {**request_residue, **copy.deepcopy(target["raw"])}


def target_d(fmt: str, current: dict[str, Any]) -> dict[str, Any]:
    """The host's own emission, labelled. ``current`` is the agent-framework
    style fixture; a pass-through host would put the raw provider array here."""
    return {"format": fmt, **copy.deepcopy(current)}


# --- normalization and diff ----------------------------------------------------------


def _as_parts(content: Any, text_type: str) -> Any:
    return (
        [{"type": text_type, "text": content}] if isinstance(content, str) else content
    )


def normalize(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    """Collapse representation choices that mean the same thing to the model:
    string content versus one text part, default-valued members, and the
    system prompt as ``instructions`` versus a leading system message."""
    req = copy.deepcopy(request)
    if fmt == CHAT:
        for m in req.get("messages", []):
            if m.get("content") is not None:
                m["content"] = _as_parts(m["content"], "text")
            for tc in m.get("tool_calls", []) or []:
                tc.pop("type", None)
            if m.get("refusal") is None:
                m.pop("refusal", None)
            if m.get("content") == [] and m.get("tool_calls"):
                m["content"] = None
        for tool in req.get("tools", []):
            if tool.get("function", {}).get("strict") is False:
                tool["function"].pop("strict")
    elif fmt == RESPONSES:
        items = list(req.get("input", []))
        if "instructions" in req:
            items.insert(0, {"role": "system", "content": req.pop("instructions")})
        for item in items:
            if item.get("type") == "message":
                item.pop("type")
            if item.get("status") == "completed":
                item.pop("status")
            if "content" in item:
                text_type = (
                    "output_text" if item.get("role") == "assistant" else "input_text"
                )
                item["content"] = _as_parts(item["content"], text_type)
                for p in item["content"]:
                    if p.get("annotations") == []:
                        p.pop("annotations")
                    if p.get("detail") == "auto":
                        p.pop("detail")
            if "output" in item:
                item["output"] = _as_parts(item["output"], "input_text")
        req["input"] = items
        for tool in req.get("tools", []):
            if tool.get("strict") is False:
                tool.pop("strict")
    elif fmt == ANTHROPIC:
        if "system" in req:
            req["system"] = _as_parts(req["system"], "text")
        for m in req.get("messages", []):
            m["content"] = _as_parts(m["content"], "text")
            for b in m["content"]:
                if b.get("type") == "tool_result":
                    if b.get("is_error") is False:
                        b.pop("is_error")
                    if "content" in b:
                        b["content"] = _as_parts(b["content"], "text")
    return req


def _label(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("type") or value.get("role") or "object")
    return type(value).__name__


def diff(expected: Any, actual: Any, path: str = "$") -> list[str]:
    """Paths where ``actual`` differs from ``expected``. Lists of different
    length are aligned by equality, then by label, so a dropped element is
    reported by its type rather than as a shift of everything after it."""
    out: list[str] = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        for k in expected:
            if k not in actual:
                out.append(f"{path}.{k} missing")
            else:
                out += diff(expected[k], actual[k], f"{path}.{k}")
        out += [f"{path}.{k} extra" for k in actual if k not in expected]
    elif isinstance(expected, list) and isinstance(actual, list):
        if len(expected) == len(actual):
            for i, (e, a) in enumerate(zip(expected, actual)):
                out += diff(e, a, f"{path}[{i}]")
            return out
        remaining = list(actual)
        for i, e in enumerate(expected):
            if e in remaining:
                remaining.remove(e)
                continue
            same = [a for a in remaining if _label(a) == _label(e)]
            if same:
                best = min(same, key=lambda a: len(diff(e, a)))
                out += diff(e, best, f"{path}[{i}]")
                remaining.remove(best)
            else:
                out.append(f"{path}[{i}] {_label(e)} missing")
        out += [f"{path}[] {_label(a)} extra" for a in remaining]
    elif expected != actual or type(expected) is not type(actual):
        out.append(f"{path} changed")
    return out


def loss(fmt: str, request: dict[str, Any], candidate: str) -> list[str]:
    """Round trip provider -> candidate target -> provider; list what differs."""
    residue = {k: v for k, v in request.items() if k not in CONVERSATION_KEYS[fmt]}
    if candidate == "A":
        restored = restore_a(fmt, target_a(fmt, request), residue)
    elif candidate == "B":
        restored = restore_b(fmt, target_b(fmt, request, keep_ext=True), residue)
    elif candidate == "B-":
        restored = restore_b(fmt, target_b(fmt, request, keep_ext=False), residue)
    elif candidate == "C":
        restored = restore_c(fmt, target_c(fmt, request), residue)
    else:
        raise ValueError(candidate)
    return diff(normalize(fmt, request), normalize(fmt, restored))
