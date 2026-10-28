# Copyright (c) Microsoft. All rights reserved.

"""Typed source of the JSON Schemas under spec/schema/.

One module per root schema builds its document with the checked
constructors in ``vocabulary``; ``FILES`` maps every output file to its
document and the serializer that reproduces the committed bytes.
``scripts/gen-schemas.py`` writes or checks them.
"""

from __future__ import annotations

from . import (
    agent_context,
    approval,
    host_declaration,
    interception_point,
    interception_record,
    interceptor_response,
    verdict,
)
from .emit import Style, ascii_escaped, compact, plain
from .vocabulary import Schema

#: Path under spec/schema/ -> (document, serializer).
FILES: dict[str, tuple[Schema, Style]] = {
    "agent-context.schema.json": (agent_context.SCHEMA, compact(agent_context.LAYOUT)),
    "approval.schema.json": (approval.SCHEMA, plain),
    "host-declaration-1.0.schema.json": (host_declaration.SCHEMA_1_0, plain),
    "host-declaration-1.1.schema.json": (host_declaration.SCHEMA_1_1, plain),
    "interception-point.schema.json": (interception_point.SCHEMA, plain),
    "interception-record.schema.json": (interception_record.SCHEMA, plain),
    "interceptor-response.schema.json": (interceptor_response.SCHEMA, plain),
    "verdict.schema.json": (verdict.SCHEMA, plain),
    **{
        f"agent-context/{point}.schema.json": (doc, ascii_escaped)
        for point, doc in agent_context.PER_POINT.items()
    },
}


def render() -> dict[str, str]:
    """Every output file's text, keyed by its path under spec/schema/."""
    return {path: style(doc) for path, (doc, style) in FILES.items()}
