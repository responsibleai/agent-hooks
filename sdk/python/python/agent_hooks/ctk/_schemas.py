# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Lazy loader for the vendored JSON schemas under ``agent_hooks/schema/``."""

from __future__ import annotations

import functools
import json
import pathlib
from typing import Any

_SCHEMA_DIR = pathlib.Path(__file__).resolve().parents[1] / "schema"


@functools.cache
def _load(name: str) -> dict[str, Any]:
    return json.loads((_SCHEMA_DIR / name).read_text(encoding="utf-8"))


def per_point_schema(interception_point: str) -> dict[str, Any]:
    return _load(f"agent-context/{interception_point}.schema.json")


@functools.lru_cache(maxsize=1)
def per_point_registry() -> Any:
    """Build a ``referencing.Registry`` so per-hook ``$ref: interception-point.schema.json``
    resolves against the vendored copy."""
    from referencing import Registry, Resource  # type: ignore[import-not-found]

    resources = []
    for p in _SCHEMA_DIR.glob("*.schema.json"):
        doc = json.loads(p.read_text(encoding="utf-8"))
        resources.append((doc["$id"], Resource.from_contents(doc)))
        # Also register under the bare filename so relative $refs in the
        # generated per-hook schemas resolve.
        resources.append((p.name, Resource.from_contents(doc)))
    return Registry().with_resources(resources)
