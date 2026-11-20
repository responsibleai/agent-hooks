# Copyright (c) Microsoft. All rights reserved.

"""The same three policy tasks written against seven target shapes.

1. Redact a secret in the latest user turn (a transform).
2. Block when any tool result contains a pattern (a deny).
3. Cap the system prompt length (a transform).

Each shape gets three locators, the only format-specific code a policy
author writes: ``user_texts``, ``tool_result_texts`` and ``system_texts``.
Each returns ``(message index, section 5.2 path, text)`` triples. The
tasks themselves are shared. The driver counts the locator lines, the
distinct path shapes a policy must know, and whether the write-back of
each transform equals the same edit made natively.
"""

from __future__ import annotations

import copy
import inspect
import json
import re
from typing import Any, Callable

import candidates as cd
import formats as fm
import neutral as nz
import paths

CHAT, RESPONSES, ANTHROPIC = nz.CHAT, nz.RESPONSES, nz.ANTHROPIC
NEUTRAL = "neutral"
TARGETS = (CHAT, RESPONSES, ANTHROPIC, NEUTRAL, fm.GEMINI, fm.BEDROCK, fm.VERCEL)

SECRET = re.compile(r"\b\d{4}-\d{4}\b")
REDACTED = "[redacted]"
SYSTEM_CAP = 20

Triple = tuple[int, str, str]

# --- locators: OpenAI chat completions ---------------------------------------------


def chat_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "user":
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target.messages[{i}].content", m["content"]))
            continue
        for j, p in enumerate(m["content"]):
            if p.get("type") == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", p["text"]))
    return out


def chat_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "tool":
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target.messages[{i}].content", m["content"]))
            continue
        for j, p in enumerate(m["content"]):
            if p.get("type") == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", p["text"]))
    return out


def chat_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] not in ("system", "developer"):
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target.messages[{i}].content", m["content"]))
            continue
        for j, p in enumerate(m["content"]):
            if p.get("type") == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", p["text"]))
    return out


# --- locators: OpenAI Responses items -------------------------------------------------


def responses_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, item in enumerate(t["input"]):
        if item.get("type", "message") != "message" or item.get("role") != "user":
            continue
        if isinstance(item["content"], str):
            out.append((i, f"$target.input[{i}].content", item["content"]))
            continue
        for j, p in enumerate(item["content"]):
            if p.get("type") == "input_text":
                out.append((i, f"$target.input[{i}].content[{j}].text", p["text"]))
    return out


def responses_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, item in enumerate(t["input"]):
        if item.get("type") != "function_call_output":
            continue
        if isinstance(item["output"], str):
            out.append((i, f"$target.input[{i}].output", item["output"]))
            continue
        for j, p in enumerate(item["output"]):
            if p.get("type") == "input_text":
                out.append((i, f"$target.input[{i}].output[{j}].text", p["text"]))
    return out


def responses_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    if isinstance(t.get("instructions"), str):
        out.append((-1, "$target.instructions", t["instructions"]))
    for i, item in enumerate(t["input"]):
        if item.get("type", "message") != "message" or item.get("role") not in (
            "system",
            "developer",
        ):
            continue
        if isinstance(item["content"], str):
            out.append((i, f"$target.input[{i}].content", item["content"]))
            continue
        for j, p in enumerate(item["content"]):
            if p.get("type") == "input_text":
                out.append((i, f"$target.input[{i}].content[{j}].text", p["text"]))
    return out


# --- locators: Anthropic Messages -------------------------------------------------------


def anthropic_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "user":
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target.messages[{i}].content", m["content"]))
            continue
        if any(b.get("type") == "tool_result" for b in m["content"]):
            continue  # a user turn that only carries tool results is not the user speaking
        for j, b in enumerate(m["content"]):
            if b.get("type") == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", b["text"]))
    return out


def anthropic_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "user" or isinstance(m["content"], str):
            continue
        for j, b in enumerate(m["content"]):
            if b.get("type") != "tool_result":
                continue
            inner = b.get("content", "")
            if isinstance(inner, str):
                out.append((i, f"$target.messages[{i}].content[{j}].content", inner))
                continue
            for k, c in enumerate(inner):
                if c.get("type") == "text":
                    out.append(
                        (
                            i,
                            f"$target.messages[{i}].content[{j}].content[{k}].text",
                            c["text"],
                        )
                    )
    return out


def anthropic_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    system = t.get("system")
    if isinstance(system, str):
        out.append((-1, "$target.system", system))
    elif isinstance(system, list):
        for j, b in enumerate(system):
            if b.get("type") == "text":
                out.append((-1, f"$target.system[{j}].text", b["text"]))
    for i, m in enumerate(t["messages"]):
        if m["role"] != "system":
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target.messages[{i}].content", m["content"]))
            continue
        for j, b in enumerate(m["content"]):
            if b.get("type") == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", b["text"]))
    return out


# --- locators: the neutral shape --------------------------------------------------------


def neutral_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "user":
            continue
        for j, p in enumerate(m["content"]):
            if p["type"] == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", p["text"]))
    return out


def neutral_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "tool":
            continue
        for j, p in enumerate(m["content"]):
            if p["type"] != "tool_result":
                continue
            for k, q in enumerate(p["content"]):
                if q["type"] == "text":
                    out.append(
                        (
                            i,
                            f"$target.messages[{i}].content[{j}].content[{k}].text",
                            q["text"],
                        )
                    )
    return out


def neutral_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "system":
            continue
        for j, p in enumerate(m["content"]):
            if p["type"] == "text":
                out.append((i, f"$target.messages[{i}].content[{j}].text", p["text"]))
    return out


# --- locators: Gemini generateContent ------------------------------------------------------


def gemini_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, c in enumerate(t["contents"]):
        if c.get("role", "user") != "user":
            continue
        if any("functionResponse" in p for p in c["parts"]):
            continue  # a user turn that carries function responses is not the user speaking
        for j, p in enumerate(c["parts"]):
            if "text" in p and not p.get("thought"):
                out.append((i, f"$target.contents[{i}].parts[{j}].text", p["text"]))
    return out


def gemini_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, c in enumerate(t["contents"]):
        for j, p in enumerate(c["parts"]):
            if "functionResponse" not in p:
                continue
            response = p["functionResponse"].get("response", {})
            text = (
                response
                if isinstance(response, str)
                else json.dumps(response, ensure_ascii=False)
            )
            out.append(
                (i, f"$target.contents[{i}].parts[{j}].functionResponse.response", text)
            )
    return out


def gemini_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for j, p in enumerate(t.get("systemInstruction", {}).get("parts", [])):
        if "text" in p:
            out.append((-1, f"$target.systemInstruction.parts[{j}].text", p["text"]))
    return out


# --- locators: Bedrock Converse ---------------------------------------------------------------


def bedrock_user_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        if m["role"] != "user":
            continue
        if any("toolResult" in b for b in m["content"]):
            continue  # a user turn that carries tool results is not the user speaking
        for j, b in enumerate(m["content"]):
            if "text" in b:
                out.append((i, f"$target.messages[{i}].content[{j}].text", b["text"]))
    return out


def bedrock_tool_result_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for i, m in enumerate(t["messages"]):
        for j, b in enumerate(m["content"]):
            if "toolResult" not in b:
                continue
            for k, c in enumerate(b["toolResult"].get("content", [])):
                if "text" in c:
                    out.append(
                        (
                            i,
                            f"$target.messages[{i}].content[{j}].toolResult.content[{k}].text",
                            c["text"],
                        )
                    )
                elif "json" in c:
                    out.append(
                        (
                            i,
                            f"$target.messages[{i}].content[{j}].toolResult.content[{k}].json",
                            json.dumps(c["json"], ensure_ascii=False),
                        )
                    )
    return out


def bedrock_system_texts(t: dict[str, Any]) -> list[Triple]:
    out = []
    for j, s in enumerate(t.get("system", [])):
        if "text" in s:
            out.append((-1, f"$target.system[{j}].text", s["text"]))
    for i, m in enumerate(t["messages"]):
        if m["role"] != "system":
            continue
        for j, b in enumerate(m["content"]):
            if "text" in b:
                out.append((i, f"$target.messages[{i}].content[{j}].text", b["text"]))
    return out


# --- locators: Vercel ModelMessage -------------------------------------------------------------


def vercel_user_texts(t: list[dict[str, Any]]) -> list[Triple]:
    out = []
    for i, m in enumerate(t):
        if m["role"] != "user":
            continue
        if isinstance(m["content"], str):
            out.append((i, f"$target[{i}].content", m["content"]))
            continue
        for j, p in enumerate(m["content"]):
            if p["type"] == "text":
                out.append((i, f"$target[{i}].content[{j}].text", p["text"]))
    return out


def vercel_tool_result_texts(t: list[dict[str, Any]]) -> list[Triple]:
    out = []
    for i, m in enumerate(t):
        if m["role"] != "tool":
            continue
        for j, p in enumerate(m["content"]):
            if p["type"] != "tool-result":
                continue
            output = p["output"]
            if output["type"] in ("text", "error-text"):
                out.append(
                    (i, f"$target[{i}].content[{j}].output.value", output["value"])
                )
            elif output["type"] in ("json", "error-json"):
                out.append(
                    (
                        i,
                        f"$target[{i}].content[{j}].output.value",
                        json.dumps(output["value"], ensure_ascii=False),
                    )
                )
            elif output["type"] == "content":
                for k, c in enumerate(output["value"]):
                    if c.get("type") == "text":
                        out.append(
                            (
                                i,
                                f"$target[{i}].content[{j}].output.value[{k}].text",
                                c["text"],
                            )
                        )
    return out


def vercel_system_texts(t: list[dict[str, Any]]) -> list[Triple]:
    out = []
    for i, m in enumerate(t):
        if m["role"] == "system":
            out.append((i, f"$target[{i}].content", m["content"]))
    return out


LOCATORS: dict[
    str,
    tuple[
        Callable[..., list[Triple]],
        Callable[..., list[Triple]],
        Callable[..., list[Triple]],
    ],
] = {
    CHAT: (chat_user_texts, chat_tool_result_texts, chat_system_texts),
    RESPONSES: (
        responses_user_texts,
        responses_tool_result_texts,
        responses_system_texts,
    ),
    ANTHROPIC: (
        anthropic_user_texts,
        anthropic_tool_result_texts,
        anthropic_system_texts,
    ),
    NEUTRAL: (neutral_user_texts, neutral_tool_result_texts, neutral_system_texts),
    fm.GEMINI: (gemini_user_texts, gemini_tool_result_texts, gemini_system_texts),
    fm.BEDROCK: (bedrock_user_texts, bedrock_tool_result_texts, bedrock_system_texts),
    fm.VERCEL: (vercel_user_texts, vercel_tool_result_texts, vercel_system_texts),
}

ARGS_KIND = {
    CHAT: "JSON string",
    RESPONSES: "JSON string",
    ANTHROPIC: "object",
    NEUTRAL: "object",
    fm.GEMINI: "object",
    fm.BEDROCK: "object",
    fm.VERCEL: "object",
}


def logic_lines(fn: Callable[..., Any]) -> int:
    """Source lines of a locator, less its signature, docstring, blanks and comments."""
    lines = inspect.getsource(fn).splitlines()[1:]
    count = 0
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or s.startswith('"""'):
            continue
        count += 1
    return count


def shape(path: str) -> str:
    return re.sub(r"\[\d+\]", "[*]", path)


# --- building a target from a provider request and restoring it ------------------------------


def build(target_fmt: str, source_fmt: str, request: dict[str, Any]) -> Any:
    if target_fmt == source_fmt:
        return cd.conversation(source_fmt, request)
    n, _ = nz.to_neutral(source_fmt, request)
    if target_fmt == NEUTRAL:
        return n
    if target_fmt == fm.VERCEL:
        return neutral_to_vercel_with_tools(n)
    bare = nz.strip_ext(n)
    if target_fmt == fm.GEMINI:
        return fm.neutral_to_gemini(bare)
    if target_fmt == fm.BEDROCK:
        return fm.neutral_to_bedrock(bare)
    out = nz.from_neutral(target_fmt, bare, {})
    return {k: v for k, v in out.items() if k in cd.CONVERSATION_KEYS[target_fmt]}


def neutral_to_vercel_with_tools(n: dict[str, Any]) -> dict[str, Any]:
    """The AI SDK keeps tools beside the messages; carry them for the round trip."""
    return {"messages": fm.neutral_to_vercel(n), "tools": copy.deepcopy(n.get("tools"))}


def restore(
    target_fmt: str, source_fmt: str, target: Any, residue: dict[str, Any]
) -> dict[str, Any]:
    if target_fmt == source_fmt:
        return {**residue, **copy.deepcopy(target)}
    if target_fmt == NEUTRAL:
        n = target
    elif target_fmt == fm.VERCEL:
        n = fm.vercel_to_neutral(target["messages"], target.get("tools"))
    elif target_fmt == fm.GEMINI:
        n = fm.gemini_to_neutral(target)
    elif target_fmt == fm.BEDROCK:
        n = fm.bedrock_to_neutral(target)
    else:
        n, _ = nz.to_neutral(target_fmt, target)
        n = nz.strip_ext(n)
    return nz.from_neutral(source_fmt, n, residue)


def _view(target_fmt: str, target: Any) -> Any:
    """The object the locators see (the AI SDK target is a message array)."""
    return target["messages"] if target_fmt == fm.VERCEL else target


def _rewrap(target_fmt: str, target: Any, view: Any) -> Any:
    return {**target, "messages": view} if target_fmt == fm.VERCEL else view


# --- the native edits, made on the provider request itself -----------------------------------


def _latest(triples: list[Triple]) -> list[Triple]:
    if not triples:
        return []
    last = max(i for i, _, _ in triples)
    return [t for t in triples if t[0] == last]


def native_redact_latest(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    req = copy.deepcopy(request)
    conv = cd.conversation(fmt, req)
    for _, path, text in _latest(LOCATORS[fmt][0](conv)):
        conv = paths.apply(conv, path, SECRET.sub(REDACTED, text))
    req.update(conv)
    return req


def native_cap_system(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    req = copy.deepcopy(request)
    conv = cd.conversation(fmt, req)
    triples = LOCATORS[fmt][2](conv)
    if triples:
        _, path, text = triples[0]
        conv = paths.apply(conv, path, text[:SYSTEM_CAP])
    req.update(conv)
    return req


def with_pii_tool_result(fmt: str, request: dict[str, Any]) -> dict[str, Any]:
    """The weather fixture with the account number leaked into the tool result."""
    text = json.dumps(request, ensure_ascii=False)
    return json.loads(
        text.replace("72°F and sunny", "72°F and sunny; account 4532-9911")
    )


# --- the three tasks, shared across shapes --------------------------------------------------


def task_redact(
    target_fmt: str, source_fmt: str, request: dict[str, Any]
) -> dict[str, Any]:
    residue = {
        k: v for k, v in request.items() if k not in cd.CONVERSATION_KEYS[source_fmt]
    }
    target = build(target_fmt, source_fmt, request)
    view = _view(target_fmt, target)
    edits = _latest(LOCATORS[target_fmt][0](view))
    for _, path, text in edits:
        view = paths.apply(view, path, SECRET.sub(REDACTED, text))
    restored = restore(
        target_fmt, source_fmt, _rewrap(target_fmt, target, view), residue
    )
    expected = native_redact_latest(source_fmt, request)
    diff = cd.diff(
        cd.normalize(source_fmt, expected), cd.normalize(source_fmt, restored)
    )
    return {"paths": [shape(p) for _, p, _ in edits], "exact": not diff, "diff": diff}


def task_block_pii(
    target_fmt: str, source_fmt: str, request: dict[str, Any]
) -> dict[str, Any]:
    target = build(target_fmt, source_fmt, request)
    found = LOCATORS[target_fmt][1](_view(target_fmt, target))
    return {
        "paths": [shape(p) for _, p, _ in found],
        "deny": any(SECRET.search(text) for _, _, text in found),
    }


def task_cap_system(
    target_fmt: str, source_fmt: str, request: dict[str, Any]
) -> dict[str, Any]:
    residue = {
        k: v for k, v in request.items() if k not in cd.CONVERSATION_KEYS[source_fmt]
    }
    target = build(target_fmt, source_fmt, request)
    view = _view(target_fmt, target)
    found = LOCATORS[target_fmt][2](view)
    if found:
        _, path, text = found[0]
        view = paths.apply(view, path, text[:SYSTEM_CAP])
    restored = restore(
        target_fmt, source_fmt, _rewrap(target_fmt, target, view), residue
    )
    expected = native_cap_system(source_fmt, request)
    diff = cd.diff(
        cd.normalize(source_fmt, expected), cd.normalize(source_fmt, restored)
    )
    return {"paths": [shape(p) for _, p, _ in found], "exact": not diff, "diff": diff}


def round_trip_loss(
    target_fmt: str, source_fmt: str, request: dict[str, Any]
) -> list[str]:
    residue = {
        k: v for k, v in request.items() if k not in cd.CONVERSATION_KEYS[source_fmt]
    }
    restored = restore(
        target_fmt, source_fmt, build(target_fmt, source_fmt, request), residue
    )
    return cd.diff(
        cd.normalize(source_fmt, request), cd.normalize(source_fmt, restored)
    )
