# Copyright (c) Microsoft. All rights reserved.

"""Three more target shapes for the ergonomics tests, each reached from the
neutral shape of ``neutral.py`` and projected back to it: Google Gemini
``generateContent`` (``contents`` and ``parts``), Amazon Bedrock Converse
(``messages`` with content blocks) and the Vercel AI SDK ``ModelMessage``.

Field names follow the public references listed in the proposal. The Vercel
shape keeps residue in ``providerOptions``, which is what that field is for;
Gemini and Bedrock have no per-part slot here and lose it. Two of the three
need the tool name on a tool result, which the neutral shape and the three
provider shapes carry only on the call, so ``tool_names`` joins them.
"""

from __future__ import annotations

import json
from typing import Any

GEMINI = "google.generate_content"
BEDROCK = "aws.bedrock_converse"
VERCEL = "vercel.model_message"


def tool_names(neutral: dict[str, Any]) -> dict[str, str]:
    names: dict[str, str] = {}
    for m in neutral["messages"]:
        for p in m["content"]:
            if p["type"] == "tool_call":
                names[p["id"]] = p["name"]
    return names


def _texts(parts: list[dict[str, Any]]) -> list[str]:
    return [q["text"] for q in parts if q["type"] == "text"]


# --- Google Gemini generateContent ---------------------------------------------


def _gemini_part_out(p: dict[str, Any], names: dict[str, str]) -> dict[str, Any] | None:
    t = p["type"]
    if t == "text" or t == "refusal":
        return {"text": p["text"]}
    if t == "media":
        src = p["source"]
        if src["type"] == "base64":
            return {
                "inlineData": {"mimeType": p.get("media_type", ""), "data": src["data"]}
            }
        if src["type"] == "url":
            fd: dict[str, Any] = {"fileUri": src["url"]}
            if "media_type" in p:
                fd["mimeType"] = p["media_type"]
            return {"fileData": fd}
        if src["type"] == "file":
            return {"fileData": {"fileUri": src["file_id"]}}
        return None
    if t == "tool_call":
        return {"functionCall": {"id": p["id"], "name": p["name"], "args": p["args"]}}
    if t == "tool_result":
        texts = _texts(p["content"])
        response: dict[str, Any] = {"content": texts[0] if len(texts) == 1 else texts}
        if p["is_error"]:
            response["error"] = True
        return {
            "functionResponse": {
                "id": p["call_id"],
                "name": names.get(p["call_id"], ""),
                "response": response,
            }
        }
    if t == "reasoning":
        part: dict[str, Any] = {"text": p.get("text", ""), "thought": True}
        if "opaque" in p:
            part["thoughtSignature"] = p["opaque"]
        return part
    return None


def neutral_to_gemini(neutral: dict[str, Any]) -> dict[str, Any]:
    names = tool_names(neutral)
    req: dict[str, Any] = {}
    system_parts: list[dict[str, Any]] = []
    contents: list[dict[str, Any]] = []
    for m in neutral["messages"]:
        parts = [
            x
            for x in (_gemini_part_out(p, names) for p in m["content"])
            if x is not None
        ]
        if m["role"] == "system":
            system_parts += parts
            continue
        contents.append(
            {"role": "model" if m["role"] == "assistant" else "user", "parts": parts}
        )
    if system_parts:
        req["systemInstruction"] = {"parts": system_parts}
    req["contents"] = contents
    if "tools" in neutral:
        decls = []
        for t in neutral["tools"]:
            d: dict[str, Any] = {"name": t["name"]}
            if "description" in t:
                d["description"] = t["description"]
            if "schema" in t:
                d["parameters"] = t["schema"]
            decls.append(d)
        req["tools"] = [{"functionDeclarations": decls}]
    return req


def _gemini_part_in(p: dict[str, Any]) -> dict[str, Any]:
    if p.get("thought"):
        part: dict[str, Any] = {"type": "reasoning", "text": p.get("text", "")}
        if "thoughtSignature" in p:
            part["opaque"] = p["thoughtSignature"]
        return part
    if "text" in p:
        return {"type": "text", "text": p["text"]}
    if "inlineData" in p:
        d = p["inlineData"]
        part = {
            "type": "media",
            "source": {"type": "base64", "data": d.get("data", "")},
        }
        if d.get("mimeType"):
            part["media_type"] = d["mimeType"]
        return part
    if "fileData" in p:
        f = p["fileData"]
        part = {"type": "media", "source": {"type": "url", "url": f["fileUri"]}}
        if f.get("mimeType"):
            part["media_type"] = f["mimeType"]
        return part
    if "functionCall" in p:
        fc = p["functionCall"]
        return {
            "type": "tool_call",
            "id": fc.get("id", ""),
            "name": fc["name"],
            "args": fc.get("args", {}),
        }
    if "functionResponse" in p:
        fr = p["functionResponse"]
        resp = fr.get("response", {})
        content = resp.get("content")
        texts = [content] if isinstance(content, str) else list(content or [])
        parts = [{"type": "text", "text": s} for s in texts] or [
            {"type": "text", "text": json.dumps(resp)}
        ]
        return {
            "type": "tool_result",
            "call_id": fr.get("id", ""),
            "content": parts,
            "is_error": bool(resp.get("error")),
        }
    return {"type": "unknown", "ext": {GEMINI: {"raw": p}}}


def gemini_to_neutral(req: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"format": GEMINI, "messages": []}
    if "systemInstruction" in req:
        out["messages"].append(
            {
                "role": "system",
                "content": [
                    _gemini_part_in(p)
                    for p in req["systemInstruction"].get("parts", [])
                ],
            }
        )
    for c in req.get("contents", []):
        parts = [_gemini_part_in(p) for p in c.get("parts", [])]
        role = "assistant" if c.get("role") == "model" else "user"
        if role == "user" and any(p["type"] == "tool_result" for p in parts):
            role = "tool"
        out["messages"].append({"role": role, "content": parts})
    if "tools" in req:
        tools = []
        for t in req["tools"]:
            for d in t.get("functionDeclarations", []):
                tool: dict[str, Any] = {"name": d["name"]}
                if "description" in d:
                    tool["description"] = d["description"]
                if "parameters" in d:
                    tool["schema"] = d["parameters"]
                tools.append(tool)
        out["tools"] = tools
    return out


# --- Amazon Bedrock Converse --------------------------------------------------------


def _bedrock_block_out(p: dict[str, Any]) -> dict[str, Any] | None:
    t = p["type"]
    if t == "text" or t == "refusal":
        return {"text": p["text"]}
    if t == "media":
        src = p["source"]
        mt = p.get("media_type", "")
        if src["type"] == "base64" and mt.startswith("image/"):
            return {
                "image": {
                    "format": mt.split("/", 1)[1],
                    "source": {"bytes": src["data"]},
                }
            }
        return None  # a URL, a file id or a digest has no Converse block
    if t == "tool_call":
        return {
            "toolUse": {"toolUseId": p["id"], "name": p["name"], "input": p["args"]}
        }
    if t == "tool_result":
        block: dict[str, Any] = {
            "toolUseId": p["call_id"],
            "content": [{"text": s} for s in _texts(p["content"])],
        }
        if p["is_error"]:
            block["status"] = "error"
        return {"toolResult": block}
    if t == "reasoning":
        if "text" in p:
            rt: dict[str, Any] = {"text": p["text"]}
            if "opaque" in p:
                rt["signature"] = p["opaque"]
            return {"reasoningContent": {"reasoningText": rt}}
        return {"reasoningContent": {"redactedContent": p.get("opaque", "")}}
    return None


def neutral_to_bedrock(neutral: dict[str, Any]) -> dict[str, Any]:
    req: dict[str, Any] = {}
    system: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    for m in neutral["messages"]:
        blocks = [
            b for b in (_bedrock_block_out(p) for p in m["content"]) if b is not None
        ]
        if m["role"] == "system":
            system += [b for b in blocks if "text" in b]
            continue
        messages.append(
            {
                "role": "assistant" if m["role"] == "assistant" else "user",
                "content": blocks,
            }
        )
    if system:
        req["system"] = system
    req["messages"] = messages
    if "tools" in neutral:
        specs = []
        for t in neutral["tools"]:
            spec: dict[str, Any] = {"name": t["name"]}
            if "description" in t:
                spec["description"] = t["description"]
            spec["inputSchema"] = {"json": t.get("schema", {"type": "object"})}
            specs.append({"toolSpec": spec})
        req["toolConfig"] = {"tools": specs}
    return req


def _bedrock_block_in(b: dict[str, Any]) -> dict[str, Any]:
    if "text" in b:
        return {"type": "text", "text": b["text"]}
    if "image" in b:
        img = b["image"]
        src = img["source"]
        if "bytes" in src:
            return {
                "type": "media",
                "media_type": f"image/{img['format']}",
                "source": {"type": "base64", "data": src["bytes"]},
            }
        return {
            "type": "media",
            "media_type": f"image/{img['format']}",
            "source": {"type": "url", "url": src["s3Location"]["uri"]},
        }
    if "toolUse" in b:
        tu = b["toolUse"]
        return {
            "type": "tool_call",
            "id": tu["toolUseId"],
            "name": tu["name"],
            "args": tu["input"],
        }
    if "toolResult" in b:
        tr = b["toolResult"]
        parts = []
        for c in tr.get("content", []):
            if "text" in c:
                parts.append({"type": "text", "text": c["text"]})
            elif "json" in c:
                parts.append({"type": "text", "text": json.dumps(c["json"])})
        return {
            "type": "tool_result",
            "call_id": tr["toolUseId"],
            "content": parts,
            "is_error": tr.get("status") == "error",
        }
    if "reasoningContent" in b:
        rc = b["reasoningContent"]
        if "reasoningText" in rc:
            part: dict[str, Any] = {
                "type": "reasoning",
                "text": rc["reasoningText"].get("text", ""),
            }
            if "signature" in rc["reasoningText"]:
                part["opaque"] = rc["reasoningText"]["signature"]
            return part
        return {"type": "reasoning", "opaque": rc.get("redactedContent", "")}
    return {"type": "unknown", "ext": {BEDROCK: {"raw": b}}}


def bedrock_to_neutral(req: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"format": BEDROCK, "messages": []}
    system = [
        {"type": "text", "text": s["text"]}
        for s in req.get("system", [])
        if "text" in s
    ]
    if system:
        out["messages"].append({"role": "system", "content": system})
    for m in req.get("messages", []):
        parts = [_bedrock_block_in(b) for b in m.get("content", [])]
        role = m["role"]
        if role == "user" and any(p["type"] == "tool_result" for p in parts):
            role = "tool"
        out["messages"].append({"role": role, "content": parts})
    if "toolConfig" in req:
        tools = []
        for t in req["toolConfig"].get("tools", []):
            spec = t.get("toolSpec")
            if not spec:
                continue
            tool: dict[str, Any] = {"name": spec["name"]}
            if "description" in spec:
                tool["description"] = spec["description"]
            if "inputSchema" in spec and "json" in spec["inputSchema"]:
                tool["schema"] = spec["inputSchema"]["json"]
            tools.append(tool)
        out["tools"] = tools
    return out


# --- Vercel AI SDK ModelMessage -------------------------------------------------------


def _vercel_part_out(p: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    t = p["type"]
    opts = dict(p.get("ext", {}))
    if t == "text" or t == "refusal":
        part: dict[str, Any] = {"type": "text", "text": p["text"]}
    elif t == "media":
        src = p["source"]
        data = (
            src.get("url")
            or src.get("data")
            or src.get("file_id")
            or src.get("sha256", "")
        )
        part = {
            "type": "file",
            "data": data,
            "mediaType": p.get("media_type", "application/octet-stream"),
        }
        opts["source_type"] = src["type"]
    elif t == "tool_call":
        part = {
            "type": "tool-call",
            "toolCallId": p["id"],
            "toolName": p["name"],
            "input": p["args"],
        }
    elif t == "reasoning":
        part = {"type": "reasoning", "text": p.get("text", "")}
        if "opaque" in p:
            opts["opaque"] = p["opaque"]
    elif t == "tool_result":
        texts = _texts(p["content"])
        if len(p["content"]) == 1 and texts:
            output: dict[str, Any] = {
                "type": "error-text" if p["is_error"] else "text",
                "value": texts[0],
            }
        else:
            output = {
                "type": "content",
                "value": [{"type": "text", "text": s} for s in texts],
            }
            if p["is_error"]:
                opts["is_error"] = True
        part = {
            "type": "tool-result",
            "toolCallId": p["call_id"],
            "toolName": names.get(p["call_id"], ""),
            "output": output,
        }
    else:
        part = {"type": "custom", "kind": "agent_hooks.unknown"}
    if opts:
        part["providerOptions"] = opts
    return part


def neutral_to_vercel(neutral: dict[str, Any]) -> list[dict[str, Any]]:
    names = tool_names(neutral)
    out: list[dict[str, Any]] = []
    for m in neutral["messages"]:
        msg: dict[str, Any] = {"role": m["role"]}
        if m["role"] == "system":
            msg["content"] = "".join(_texts(m["content"]))
            opts = {k: v for p in m["content"] for k, v in p.get("ext", {}).items()}
        else:
            msg["content"] = [_vercel_part_out(p, names) for p in m["content"]]
            opts = {}
        if m.get("ext"):
            opts["message"] = m["ext"]
        if "name" in m:
            opts["name"] = m["name"]
        if opts:
            msg["providerOptions"] = opts
        out.append(msg)
    return out


def _vercel_part_in(p: dict[str, Any]) -> dict[str, Any]:
    opts = dict(p.get("providerOptions", {}))
    t = p["type"]
    if t == "text":
        part: dict[str, Any] = {"type": "text", "text": p["text"]}
    elif t in ("file", "image"):
        kind = opts.pop("source_type", "url")
        data = p.get("data", p.get("image", ""))
        key = {"url": "url", "base64": "data", "file": "file_id", "digest": "sha256"}[
            kind
        ]
        part = {"type": "media", "source": {"type": kind, key: data}}
        if p.get("mediaType") and p["mediaType"] != "application/octet-stream":
            part["media_type"] = p["mediaType"]
    elif t == "tool-call":
        part = {
            "type": "tool_call",
            "id": p["toolCallId"],
            "name": p["toolName"],
            "args": p["input"],
        }
    elif t == "reasoning":
        part = {"type": "reasoning", "text": p.get("text", "")}
        if "opaque" in opts:
            part["opaque"] = opts.pop("opaque")
    elif t == "tool-result":
        out = p["output"]
        if out["type"] in ("text", "error-text"):
            content = [{"type": "text", "text": out["value"]}]
        elif out["type"] in ("json", "error-json"):
            content = [{"type": "text", "text": json.dumps(out["value"])}]
        else:
            content = [
                {"type": "text", "text": c["text"]}
                for c in out.get("value", [])
                if c.get("type") == "text"
            ]
        is_error = out["type"].startswith("error") or bool(opts.pop("is_error", False))
        part = {
            "type": "tool_result",
            "call_id": p["toolCallId"],
            "content": content,
            "is_error": is_error,
        }
    else:
        part = {"type": "unknown"}
    if opts:
        part["ext"] = opts
    return part


def vercel_to_neutral(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {"format": VERCEL, "messages": []}
    for m in messages:
        opts = dict(m.get("providerOptions", {}))
        name = opts.pop("name", None)
        message_ext = opts.pop("message", {})
        if m["role"] == "system":
            part: dict[str, Any] = {"type": "text", "text": m["content"]}
            if opts:
                part["ext"] = opts
            opts = message_ext
            msg: dict[str, Any] = {"role": "system", "content": [part]}
        else:
            content = (
                m["content"]
                if isinstance(m["content"], list)
                else [{"type": "text", "text": m["content"]}]
            )
            msg = {"role": m["role"], "content": [_vercel_part_in(p) for p in content]}
            opts = message_ext
        if name is not None:
            msg["name"] = name
        if opts:
            msg["ext"] = opts
        out["messages"].append(msg)
    if tools is not None:
        out["tools"] = tools
    return out
