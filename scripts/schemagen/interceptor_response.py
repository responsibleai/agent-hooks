# Copyright (c) Microsoft. All rights reserved.

"""interceptor-response.schema.json: the response envelope (§5.5)."""

from __future__ import annotations

from .common import EXTENSION_KEY
from .vocabulary import document, obj, ref, schema

SCHEMA = document(
    "interceptor-response",
    title="Agent Hooks — interceptor response",
    description="Response envelope adopted under P-006 (Decided 2026-10-15) as part of the "
    "0.1 contract (§5.5). Bare Verdict remains valid; transport metadata never changes "
    "enforcement.",
    body=schema(
        oneOf=[
            ref("verdict.schema.json"),
            obj(
                additionalProperties=False,
                required=["verdict"],
                properties={
                    "verdict": ref("verdict.schema.json"),
                    "extensions": obj(
                        propertyNames=schema(pattern=EXTENSION_KEY),
                        additionalProperties=True,
                        description="Opaque namespaced transport metadata (§4.6), including "
                        "provider receipts under extensions.<provider>.receipt. Canonical "
                        "extensions are bounded at 65536 bytes (§5.5).",
                    ),
                },
            ),
        ]
    ),
)
