# Copyright (c) Microsoft. All rights reserved.

"""Candidate B: a small neutral request shape with projections to and from
three provider shapes.

Neutral request::

    {"format": "<source format>", "messages": [message, ...], "tools": [tool, ...]}
    message = {"role": system|user|assistant|tool, "content": [part, ...], "name"?: str, "ext"?: {...}}
    part    = {"type": "text", "text": str}
            | {"type": "media", "media_type"?: str, "source": {"type": url|base64|file, ...}}
            | {"type": "tool_call", "id": str, "name": str, "args": object}
            | {"type": "tool_result", "call_id": str, "content": [part, ...], "is_error": bool}
            | {"type": "reasoning", "text"?: str, "opaque"?: str}
            | {"type": "refusal", "text": str}
            | {"type": "unknown"}
    tool    = {"name": str, "description"?: str, "schema"?: object}

Every object may carry ``ext: {"<format>": {...}}`` with the members the
neutral fields have no slot for. A projection followed by a restore returns
the provider payload; ``strip_ext`` shows what the neutral fields alone carry.
Request-level members other than the conversation (model, sampling options)
are returned separately; in the specification they belong to ``model``.
"""

from __future__ import annotations

import copy
import json
from typing import Any

CHAT = "openai.chat"
RESPONSES = "openai.responses"
ANTHROPIC = "anthropic.messages"
FORMATS = (CHAT, RESPONSES, ANTHROPIC)


def _ext(obj: dict[str, Any], fmt: str, residue: dict[str, Any]) -> None:
    if residue:
        obj.setdefault("ext", {})[fmt] = residue


def _res(obj: dict[str, Any], fmt: str) -> dict[str, Any]:
    return dict(obj.get("ext", {}).get(fmt, {}))


def _text(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _compact(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _args_in(arguments: str, residue: dict[str, Any]) -> Any:
    """Parse a provider's JSON argument string. ``None`` means it did not
    parse; the caller then projects the call as an ``unknown`` part."""
    try:
        args = json.loads(arguments)
    except ValueError:
        return None
    if _compact(args) != arguments:
        residue["arguments"] = arguments
    return args


def _args_out(part: dict[str, Any], fmt: str) -> str:
    return _res(part, fmt).get("arguments", _compact(part["args"]))


def _data_url_in(url: str) -> dict[str, Any]:
    head, _, data = url.partition(",")
    media_type = head[len("data:") :].split(";")[0]
    return {"type": "base64", "media_type": media_type, "data": data}


def _data_url_out(source: dict[str, Any]) -> str:
    return f"data:{source.get('media_type', '')};base64,{source['data']}"


def _media(source: dict[str, Any], media_type: str | None = None) -> dict[str, Any]:
    part: dict[str, Any] = {"type": "media"}
    mt = media_type or source.pop("media_type", None)
    if mt:
        part["media_type"] = mt
    part["source"] = source
    return part


def strip_ext(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: strip_ext(v) for k, v in value.items() if k != "ext"}
    if isinstance(value, list):
        return [strip_ext(v) for v in value]
    return value


def to_neutral(
    fmt: str, request: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Project a provider request. Returns (neutral request, request-level residue)."""
    return {
        CHAT: chat_to_neutral,
        RESPONSES: responses_to_neutral,
        ANTHROPIC: anthropic_to_neutral,
    }[fmt](request)


def from_neutral(
    fmt: str, neutral: dict[str, Any], request_residue: dict[str, Any] | None = None
) -> dict[str, Any]:
    fn = {
        CHAT: neutral_to_chat,
        RESPONSES: neutral_to_responses,
        ANTHROPIC: neutral_to_anthropic,
    }[fmt]
    return fn(neutral, request_residue or {})


# --- OpenAI chat completions ---------------------------------------------------


def _chat_parts_in(content: Any, residue: dict[str, Any]) -> list[dict[str, Any]]:
    if content is None:
        return []
    if isinstance(content, str):
        return [_text(content)]
    parts: list[dict[str, Any]] = []
    for raw in content:
        raw = dict(raw)
        kind = raw.pop("type", None)
        part_res: dict[str, Any] = {}
        if kind == "text":
            part = _text(raw.pop("text"))
        elif kind == "image_url":
            image = dict(raw.pop("image_url"))
            url = image.pop("url")
            part = _media(
                _data_url_in(url)
                if url.startswith("data:")
                else {"type": "url", "url": url}
            )
            part_res.update(image)  # detail
        elif kind == "input_audio":
            audio = dict(raw.pop("input_audio"))
            part = _media(
                {"type": "base64", "data": audio.pop("data")},
                f"audio/{audio.pop('format', 'wav')}",
            )
        elif kind == "file":
            file = dict(raw.pop("file"))
            if "file_id" in file:
                part = _media({"type": "file", "file_id": file.pop("file_id")})
            else:
                part = _media({"type": "base64", "data": file.pop("file_data", "")})
            part_res.update(file)  # filename
        elif kind == "refusal":
            part = {"type": "refusal", "text": raw.pop("refusal")}
        else:
            part = {"type": "unknown"}
            part_res["raw"] = {"type": kind, **raw}
            raw = {}
        part_res.update(raw)
        _ext(part, CHAT, part_res)
        parts.append(part)
    return parts


def _chat_parts_out(parts: list[dict[str, Any]]) -> Any:
    """Restore convention: no parts -> null, one plain text part -> string, else parts."""
    if not parts:
        return None
    if len(parts) == 1 and parts[0]["type"] == "text" and not _res(parts[0], CHAT):
        return parts[0]["text"]
    out: list[dict[str, Any]] = []
    for p in parts:
        res = _res(p, CHAT)
        if p["type"] == "text":
            out.append({"type": "text", "text": p["text"], **res})
        elif p["type"] == "media":
            src = p["source"]
            if src["type"] == "url":
                out.append(
                    {"type": "image_url", "image_url": {"url": src["url"], **res}}
                )
            elif src["type"] == "base64" and str(p.get("media_type", "")).startswith(
                "audio/"
            ):
                out.append(
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": src["data"],
                            "format": p["media_type"].split("/")[1],
                        },
                    }
                )
            elif src["type"] == "base64":
                out.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": _data_url_out(
                                {**src, "media_type": p.get("media_type", "")}
                            ),
                            **res,
                        },
                    }
                )
            else:
                out.append({"type": "file", "file": {"file_id": src["file_id"], **res}})
        elif p["type"] == "refusal":
            out.append({"type": "refusal", "refusal": p["text"]})
        elif p["type"] == "unknown" and "raw" in res:
            out.append(res["raw"])
        # reasoning parts have no slot in chat completions and are dropped here
    return out


def chat_to_neutral(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    req = copy.deepcopy(request)
    messages = req.pop("messages")
    tools = req.pop("tools", None)
    out: dict[str, Any] = {"format": CHAT, "messages": []}
    for m in messages:
        m = dict(m)
        role = m.pop("role")
        residue: dict[str, Any] = {}
        if role == "tool":
            call_id = m.pop("tool_call_id")
            content = _chat_parts_in(m.pop("content", None), residue)
            msg = {
                "role": "tool",
                "content": [
                    {
                        "type": "tool_result",
                        "call_id": call_id,
                        "content": content,
                        "is_error": False,
                    }
                ],
            }
        else:
            if role == "developer":
                residue["role"] = "developer"
                role = "system"
            parts = _chat_parts_in(m.pop("content", None), residue)
            for tc in m.pop("tool_calls", None) or []:
                tc = dict(tc)
                tc_res: dict[str, Any] = {}
                args = (
                    _args_in(tc["function"]["arguments"], tc_res)
                    if tc.get("type", "function") == "function"
                    else None
                )
                if args is not None:
                    fn = tc.pop("function")
                    part = {
                        "type": "tool_call",
                        "id": tc.pop("id"),
                        "name": fn["name"],
                        "args": args,
                    }
                    tc.pop("type", None)
                    tc_res.update(tc)
                else:
                    part = {"type": "unknown"}
                    tc_res["raw"] = tc
                _ext(part, CHAT, tc_res)
                parts.append(part)
            refusal = m.pop("refusal", None)
            if refusal is not None:
                parts.append({"type": "refusal", "text": refusal})
            msg = {"role": role, "content": parts}
        name = m.pop("name", None)
        if name is not None:
            msg["name"] = name
        residue.update(m)
        _ext(msg, CHAT, residue)
        out["messages"].append(msg)
    if tools is not None:
        out["tools"] = []
        for t in tools:
            t = dict(t)
            if t.get("type") == "function":
                fn = dict(t.pop("function"))
                tool = {"name": fn.pop("name")}
                if "description" in fn:
                    tool["description"] = fn.pop("description")
                if "parameters" in fn:
                    tool["schema"] = fn.pop("parameters")
                t.pop("type")
                _ext(tool, CHAT, {**fn, **t})
            else:
                tool = {"name": t.get("type", "unknown")}
                _ext(tool, CHAT, {"raw": t})
            out["tools"].append(tool)
    return out, req


def neutral_to_chat(
    neutral: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    req = dict(request_residue)
    req["messages"] = []
    for m in neutral["messages"]:
        res = _res(m, CHAT)
        if m["role"] == "tool":
            for p in m["content"]:
                if p["type"] == "tool_result":
                    content = _chat_parts_out(p["content"])
                    tool_msg = {
                        "role": "tool",
                        "tool_call_id": p["call_id"],
                        "content": "" if content is None else content,
                    }
                    req["messages"].append(tool_msg)
            continue
        msg: dict[str, Any] = {"role": res.pop("role", m["role"])}
        body = [p for p in m["content"] if p["type"] not in ("tool_call",)]
        calls = [p for p in m["content"] if p["type"] == "tool_call"]
        msg["content"] = _chat_parts_out(body)
        if calls:
            msg["tool_calls"] = [
                {
                    "id": c["id"],
                    "type": "function",
                    "function": {"name": c["name"], "arguments": _args_out(c, CHAT)},
                    **{k: v for k, v in _res(c, CHAT).items() if k != "arguments"},
                }
                for c in calls
            ]
        if "name" in m:
            msg["name"] = m["name"]
        msg.update(res)
        req["messages"].append(msg)
    if "tools" in neutral:
        req["tools"] = []
        for t in neutral["tools"]:
            res = _res(t, CHAT)
            if "raw" in res:
                req["tools"].append(res["raw"])
                continue
            fn: dict[str, Any] = {"name": t["name"]}
            if "description" in t:
                fn["description"] = t["description"]
            if "schema" in t:
                fn["parameters"] = t["schema"]
            fn.update(res)
            req["tools"].append({"type": "function", "function": fn})
    return req


# --- OpenAI Responses -----------------------------------------------------------


def _responses_input_parts_in(
    content: Any, residue: dict[str, Any]
) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [_text(content)]
    parts: list[dict[str, Any]] = []
    for raw in content:
        raw = dict(raw)
        kind = raw.pop("type")
        part_res: dict[str, Any] = {}
        if kind == "input_text":
            part = _text(raw.pop("text"))
        elif kind == "input_image":
            url = raw.pop("image_url", None)
            if url is not None:
                part = _media(
                    _data_url_in(url)
                    if url.startswith("data:")
                    else {"type": "url", "url": url}
                )
            else:
                part = _media({"type": "file", "file_id": raw.pop("file_id")})
        elif kind == "input_file":
            if "file_id" in raw:
                part = _media({"type": "file", "file_id": raw.pop("file_id")})
            elif "file_url" in raw:
                part = _media({"type": "url", "url": raw.pop("file_url")})
            else:
                part = _media({"type": "base64", "data": raw.pop("file_data", "")})
        elif kind == "output_text":
            part = _text(raw.pop("text"))
            if not raw.get("annotations"):
                raw.pop("annotations", None)
        elif kind == "refusal":
            part = {"type": "refusal", "text": raw.pop("refusal")}
        else:
            part = {"type": "unknown"}
            part_res["raw"] = {"type": kind, **raw}
            raw = {}
        part_res.update(raw)
        _ext(part, RESPONSES, part_res)
        parts.append(part)
    return parts


def _responses_item_in(item: dict[str, Any]) -> dict[str, Any]:
    item = dict(item)
    kind = item.get("type", "message")
    residue: dict[str, Any] = {}
    if kind == "message":
        item.pop("type", None)
        role = item.pop("role")
        if role == "developer":
            residue["role"] = "developer"
            role = "system"
        parts = _responses_input_parts_in(item.pop("content"), residue)
        msg = {"role": role, "content": parts}
    elif (
        kind == "function_call"
        and (args := _args_in(item.get("arguments", ""), {})) is not None
    ):
        item.pop("type")
        tc_res: dict[str, Any] = {}
        if _compact(args) != item["arguments"]:
            tc_res["arguments"] = item["arguments"]
        item.pop("arguments")
        part = {
            "type": "tool_call",
            "id": item.pop("call_id"),
            "name": item.pop("name"),
            "args": args,
        }
        _ext(part, RESPONSES, tc_res)
        msg = {"role": "assistant", "content": [part]}
    elif kind == "function_call_output":
        item.pop("type")
        output = item.pop("output")
        tr_res: dict[str, Any] = {}
        content = _responses_input_parts_in(output, tr_res)
        part = {
            "type": "tool_result",
            "call_id": item.pop("call_id"),
            "content": content,
            "is_error": False,
        }
        _ext(part, RESPONSES, tr_res)
        msg = {"role": "tool", "content": [part]}
    elif kind == "reasoning":
        item.pop("type")
        part: dict[str, Any] = {"type": "reasoning"}
        summary = item.pop("summary", [])
        if len(summary) == 1 and summary[0].get("type") == "summary_text":
            part["text"] = summary[0]["text"]
        elif summary:
            residue["summary"] = summary
        if item.get("encrypted_content") is not None:
            part["opaque"] = item.pop("encrypted_content")
        msg = {"role": "assistant", "content": [part]}
    else:
        part = {"type": "unknown"}
        _ext(part, RESPONSES, {"raw": item})
        item = {}
        msg = {"role": "assistant", "content": [part]}
    residue.update(item)  # id, status, phase, ...
    _ext(msg, RESPONSES, residue)
    return msg


def responses_to_neutral(
    request: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    req = copy.deepcopy(request)
    items = req.pop("input")
    tools = req.pop("tools", None)
    instructions = req.pop("instructions", None)
    out: dict[str, Any] = {"format": RESPONSES, "messages": []}
    if instructions is not None:
        msg = {"role": "system", "content": [_text(instructions)]}
        _ext(msg, RESPONSES, {"placement": "instructions"})
        out["messages"].append(msg)
    if isinstance(items, str):
        items = [{"role": "user", "content": items}]
    for item in items:
        out["messages"].append(_responses_item_in(item))
    if tools is not None:
        out["tools"] = []
        for t in tools:
            t = dict(t)
            if t.get("type") == "function":
                t.pop("type")
                tool = {"name": t.pop("name")}
                if t.get("description") is not None:
                    tool["description"] = t.pop("description")
                else:
                    t.pop("description", None)
                if t.get("parameters") is not None:
                    tool["schema"] = t.pop("parameters")
                _ext(tool, RESPONSES, t)
            else:
                tool = {"name": t.get("type", "unknown")}
                _ext(tool, RESPONSES, {"raw": t})
            out["tools"].append(tool)
    return out, req


def _responses_parts_out(
    parts: list[dict[str, Any]], output_side: bool
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in parts:
        res = _res(p, RESPONSES)
        if p["type"] == "text" and output_side:
            out.append(
                {
                    "type": "output_text",
                    "text": p["text"],
                    "annotations": res.pop("annotations", []),
                    **res,
                }
            )
        elif p["type"] == "text":
            out.append({"type": "input_text", "text": p["text"], **res})
        elif p["type"] == "media":
            src = p["source"]
            if src["type"] == "url" and str(p.get("media_type", "image/")).startswith(
                "image/"
            ):
                out.append({"type": "input_image", "image_url": src["url"], **res})
            elif src["type"] == "url":
                out.append({"type": "input_file", "file_url": src["url"], **res})
            elif src["type"] == "base64" and str(
                p.get("media_type", "image/")
            ).startswith("image/"):
                out.append(
                    {
                        "type": "input_image",
                        "image_url": _data_url_out(
                            {**src, "media_type": p.get("media_type", "")}
                        ),
                        **res,
                    }
                )
            elif src["type"] == "base64":
                out.append({"type": "input_file", "file_data": src["data"], **res})
            else:
                out.append(
                    {
                        "type": "input_image"
                        if str(p.get("media_type", "image/")).startswith("image/")
                        else "input_file",
                        "file_id": src["file_id"],
                        **res,
                    }
                )
        elif p["type"] == "refusal":
            out.append({"type": "refusal", "refusal": p["text"]})
        elif p["type"] == "unknown" and "raw" in res:
            out.append(res["raw"])
    return out


def neutral_to_responses(
    neutral: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    req = dict(request_residue)
    items: list[dict[str, Any]] = []
    for m in neutral["messages"]:
        res = _res(m, RESPONSES)
        if m["role"] == "system" and res.get("placement") == "instructions":
            req["instructions"] = "".join(
                p["text"] for p in m["content"] if p["type"] == "text"
            )
            continue
        if m["role"] in ("system", "user"):
            item: dict[str, Any] = {
                "type": "message",
                "role": res.pop("role", m["role"]),
            }
            item["content"] = _responses_parts_out(m["content"], output_side=False)
            item.update(res)
            items.append(item)
        elif m["role"] == "tool":
            for p in m["content"]:
                if p["type"] != "tool_result":
                    continue
                texts = [q for q in p["content"] if q["type"] == "text"]
                output: Any
                if len(p["content"]) == 1 and texts:
                    output = texts[0]["text"]
                else:
                    output = _responses_parts_out(p["content"], output_side=False)
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": p["call_id"],
                        "output": output,
                        **res,
                    }
                )
        else:  # assistant
            body: list[dict[str, Any]] = []

            def flush() -> None:
                if body:
                    msg_item = {
                        "type": "message",
                        "role": "assistant",
                        "content": _responses_parts_out(body, output_side=True),
                    }
                    msg_item.update(res)
                    items.append(msg_item)
                    body.clear()

            for p in m["content"]:
                if p["type"] == "tool_call":
                    flush()
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": p["id"],
                            "name": p["name"],
                            "arguments": _args_out(p, RESPONSES),
                            **res,
                        }
                    )
                elif p["type"] == "reasoning":
                    flush()
                    item = {"type": "reasoning"}
                    if "summary" in res:
                        item["summary"] = res["summary"]
                    elif "text" in p:
                        item["summary"] = [{"type": "summary_text", "text": p["text"]}]
                    else:
                        item["summary"] = []
                    if "opaque" in p:
                        item["encrypted_content"] = p["opaque"]
                    item.update({k: v for k, v in res.items() if k != "summary"})
                    items.append(item)
                else:
                    body.append(p)
            flush()
    req["input"] = items
    if "tools" in neutral:
        req["tools"] = []
        for t in neutral["tools"]:
            res = _res(t, RESPONSES)
            if "raw" in res:
                req["tools"].append(res["raw"])
                continue
            tool: dict[str, Any] = {"type": "function", "name": t["name"]}
            if "description" in t:
                tool["description"] = t["description"]
            if "schema" in t:
                tool["parameters"] = t["schema"]
            tool.update(res)
            req["tools"].append(tool)
    return req


# --- Anthropic Messages ----------------------------------------------------------


def _anthropic_blocks_in(content: Any, residue: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [_text(content)]
    parts: list[dict[str, Any]] = []
    for raw in content:
        raw = dict(raw)
        kind = raw.pop("type")
        part_res: dict[str, Any] = {}
        if kind == "text":
            part = _text(raw.pop("text"))
        elif kind in ("image", "document"):
            src = dict(raw.pop("source"))
            stype = src.pop("type")
            if stype == "base64":
                part = _media(
                    {"type": "base64", "data": src.pop("data")},
                    src.pop("media_type", None),
                )
            elif stype == "url":
                part = _media(
                    {"type": "url", "url": src.pop("url")},
                    None if kind == "image" else "application/pdf",
                )
            elif stype == "file":
                part = _media({"type": "file", "file_id": src.pop("file_id")})
            else:
                part = _media({"type": stype, **src})
                src = {}
            if kind == "document":
                part_res["block"] = kind
            part_res.update(src)
        elif kind == "tool_use":
            part = {
                "type": "tool_call",
                "id": raw.pop("id"),
                "name": raw.pop("name"),
                "args": raw.pop("input"),
            }
        elif kind == "tool_result":
            tr_res: dict[str, Any] = {}
            inner = raw.pop("content", None)
            content_parts = [] if inner is None else _anthropic_blocks_in(inner, tr_res)
            part = {
                "type": "tool_result",
                "call_id": raw.pop("tool_use_id"),
                "content": content_parts,
                "is_error": bool(raw.pop("is_error", False)),
            }
            part_res.update(tr_res)
        elif kind == "thinking":
            part = {
                "type": "reasoning",
                "text": raw.pop("thinking"),
                "opaque": raw.pop("signature"),
            }
        elif kind == "redacted_thinking":
            part = {"type": "reasoning", "opaque": raw.pop("data")}
            part_res["redacted"] = True
        else:
            part = {"type": "unknown"}
            part_res["raw"] = {"type": kind, **raw}
            raw = {}
        part_res.update(raw)  # cache_control, citations, title, ...
        _ext(part, ANTHROPIC, part_res)
        parts.append(part)
    return parts


def anthropic_to_neutral(
    request: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    req = copy.deepcopy(request)
    messages = req.pop("messages")
    tools = req.pop("tools", None)
    system = req.pop("system", None)
    out: dict[str, Any] = {"format": ANTHROPIC, "messages": []}
    if system is not None:
        residue: dict[str, Any] = {}
        msg = {"role": "system", "content": _anthropic_blocks_in(system, residue)}
        _ext(msg, ANTHROPIC, residue)
        out["messages"].append(msg)
    for m in messages:
        m = dict(m)
        role = m.pop("role")
        residue = {}
        parts = _anthropic_blocks_in(m.pop("content"), residue)
        if role == "user" and any(p["type"] == "tool_result" for p in parts):
            role = "tool"
        msg = {"role": role, "content": parts}
        residue.update(m)
        _ext(msg, ANTHROPIC, residue)
        out["messages"].append(msg)
    if tools is not None:
        out["tools"] = []
        for t in tools:
            t = dict(t)
            if "input_schema" in t and "name" in t:
                tool = {"name": t.pop("name")}
                if "description" in t:
                    tool["description"] = t.pop("description")
                tool["schema"] = t.pop("input_schema")
                _ext(tool, ANTHROPIC, t)
            else:
                tool = {"name": t.get("name") or t.get("type", "unknown")}
                _ext(tool, ANTHROPIC, {"raw": t})
            out["tools"].append(tool)
    return out, req


def _anthropic_blocks_out(parts: list[dict[str, Any]]) -> Any:
    """Restore convention: one plain text part -> string, else blocks."""
    if len(parts) == 1 and parts[0]["type"] == "text" and not _res(parts[0], ANTHROPIC):
        return parts[0]["text"]
    out: list[dict[str, Any]] = []
    for p in parts:
        res = _res(p, ANTHROPIC)
        if p["type"] == "text":
            out.append({"type": "text", "text": p["text"], **res})
        elif p["type"] == "media":
            block = res.pop("block", None) or (
                "image"
                if str(p.get("media_type", "image/")).startswith("image/")
                else "document"
            )
            src = dict(p["source"])
            if src["type"] == "base64" and "media_type" in p:
                src = {
                    "type": "base64",
                    "media_type": p["media_type"],
                    "data": src["data"],
                }
            out.append({"type": block, "source": src, **res})
        elif p["type"] == "tool_call":
            out.append(
                {
                    "type": "tool_use",
                    "id": p["id"],
                    "name": p["name"],
                    "input": p["args"],
                    **res,
                }
            )
        elif p["type"] == "tool_result":
            block = {"type": "tool_result", "tool_use_id": p["call_id"]}
            if p["content"]:
                block["content"] = _anthropic_blocks_out(p["content"])
            if p["is_error"]:
                block["is_error"] = True
            block.update(res)
            out.append(block)
        elif p["type"] == "reasoning":
            if res.pop("redacted", False):
                out.append(
                    {"type": "redacted_thinking", "data": p.get("opaque", ""), **res}
                )
            else:
                out.append(
                    {
                        "type": "thinking",
                        "thinking": p.get("text", ""),
                        "signature": p.get("opaque", ""),
                        **res,
                    }
                )
        elif p["type"] == "unknown" and "raw" in res:
            out.append(res["raw"])
        # refusal parts have no block in the Messages API and are dropped here
    return out


def _as_blocks(content: Any) -> list[dict[str, Any]]:
    return (
        [{"type": "text", "text": content}]
        if isinstance(content, str)
        else list(content)
    )


def neutral_to_anthropic(
    neutral: dict[str, Any], request_residue: dict[str, Any]
) -> dict[str, Any]:
    req = dict(request_residue)
    system_parts: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    for m in neutral["messages"]:
        res = _res(m, ANTHROPIC)
        if m["role"] == "system":
            system_parts.extend(m["content"])
            continue
        role = "user" if m["role"] == "tool" else m["role"]
        msg = {"role": role, "content": _anthropic_blocks_out(m["content"])}
        msg.update(res)
        if messages and messages[-1]["role"] == role and not res:
            # The Messages API alternates roles: fold a split turn back into one message.
            previous = messages[-1]
            previous["content"] = _as_blocks(previous["content"]) + _as_blocks(
                msg["content"]
            )
            continue
        messages.append(msg)
    if system_parts:
        req["system"] = _anthropic_blocks_out(system_parts)
    req["messages"] = messages
    if "tools" in neutral:
        req["tools"] = []
        for t in neutral["tools"]:
            res = _res(t, ANTHROPIC)
            if "raw" in res:
                req["tools"].append(res["raw"])
                continue
            tool: dict[str, Any] = {"name": t["name"]}
            if "description" in t:
                tool["description"] = t["description"]
            tool["input_schema"] = t.get("schema", {"type": "object"})
            tool.update(res)
            req["tools"].append(tool)
    return req


# --- post_model_call: provider responses to the neutral response ----------------

FINISH = {
    CHAT: {
        "stop": "stop",
        "length": "length",
        "tool_calls": "tool_calls",
        "content_filter": "content_filter",
        "function_call": "tool_calls",
    },
    ANTHROPIC: {
        "end_turn": "stop",
        "stop_sequence": "stop",
        "max_tokens": "length",
        "tool_use": "tool_calls",
        "refusal": "refusal",
        "pause_turn": "other",
    },
}


def response_to_neutral(
    fmt: str, response: dict[str, Any]
) -> tuple[dict[str, Any], list[str]]:
    """Project a provider response into {format, content: [parts], tool_calls, finish_reason}.

    Returns the projection and the list of provider members the neutral
    fields do not carry (candidates for ``ext``).
    """
    resp = copy.deepcopy(response)
    dropped: list[str] = []
    if fmt == CHAT:
        choice = resp["choices"][0]
        message = dict(choice["message"])
        parts: list[dict[str, Any]] = []
        content = message.pop("content", None)
        if isinstance(content, str):
            parts.append(_text(content))
        elif content:
            parts.extend(_chat_parts_in(content, {}))
        refusal = message.pop("refusal", None)
        if refusal:
            parts.append({"type": "refusal", "text": refusal})
        calls = [
            {
                "id": tc["id"],
                "name": tc["function"]["name"],
                "args": json.loads(tc["function"]["arguments"]),
            }
            for tc in message.pop("tool_calls", None) or []
        ]
        message.pop("role", None)
        dropped += [
            f"choices[0].message.{k}" for k, v in message.items() if v not in (None, [])
        ]
        dropped += [k for k in resp if k not in ("choices", "model", "usage")]
        out = {
            "format": fmt,
            "content": parts,
            "tool_calls": calls,
            "finish_reason": FINISH[CHAT].get(choice["finish_reason"], "other"),
        }
        _ext(out, fmt, {"finish_reason": choice["finish_reason"]})
        return out, dropped
    if fmt == RESPONSES:
        parts = []
        calls = []
        for item in resp["output"]:
            kind = item["type"]
            if kind == "message":
                parts.extend(_responses_input_parts_in(item["content"], {}))
                dropped += [
                    f"output[].message.{k}" for k in ("id", "status") if k in item
                ]
            elif kind == "function_call":
                calls.append(
                    {
                        "id": item["call_id"],
                        "name": item["name"],
                        "args": json.loads(item["arguments"]),
                    }
                )
                dropped += [
                    f"output[].function_call.{k}" for k in ("id", "status") if k in item
                ]
            elif kind == "reasoning":
                part = {"type": "reasoning"}
                summary = item.get("summary", [])
                if len(summary) == 1:
                    part["text"] = summary[0]["text"]
                if item.get("encrypted_content"):
                    part["opaque"] = item["encrypted_content"]
                parts.append(part)
                dropped += [
                    f"output[].reasoning.{k}" for k in ("id", "status") if k in item
                ]
            else:
                parts.append({"type": "unknown"})
                dropped.append(f"output[].{kind}")
        finish = (
            "tool_calls"
            if calls
            else {"completed": "stop", "incomplete": "length"}.get(
                resp.get("status", ""), "other"
            )
        )
        dropped += [k for k in resp if k not in ("output", "model", "usage", "status")]
        out = {
            "format": fmt,
            "content": parts,
            "tool_calls": calls,
            "finish_reason": finish,
        }
        _ext(out, fmt, {"status": resp.get("status")})
        return out, dropped
    parts = _anthropic_blocks_in(resp["content"], {})
    calls = [
        {"id": p["id"], "name": p["name"], "args": p["args"]}
        for p in parts
        if p["type"] == "tool_call"
    ]
    parts = [p for p in parts if p["type"] != "tool_call"]
    dropped += [
        k
        for k in resp
        if k not in ("content", "model", "usage", "stop_reason", "role", "type")
    ]
    out = {
        "format": fmt,
        "content": parts,
        "tool_calls": calls,
        "finish_reason": FINISH[ANTHROPIC].get(resp["stop_reason"], "other"),
    }
    _ext(out, fmt, {"stop_reason": resp["stop_reason"]})
    return out, dropped
