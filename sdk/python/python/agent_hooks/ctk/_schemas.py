# Copyright (c) Microsoft. All rights reserved.

"""Lazy loader for the vendored JSON schemas under ``agent_hooks/schema/``.

One folder per supported specification version, named after its
``spec/<version>/`` bundle (``0.1``, ``draft``); each holds that
bundle's generated schemas with the per-point context schemas under
``agent-context/``. A caller names the version by its wire string.
"""

from __future__ import annotations

import functools
import json
import pathlib
from typing import Any

from agent_hooks._types import require_spec_version

_SCHEMA_DIR = pathlib.Path(__file__).resolve().parents[1] / "schema"


def schema_dir(spec: str) -> pathlib.Path:
    """The vendored schema folder of the specification version ``spec``
    names (a wire string): ``agent-hooks/0.1`` is ``schema/0.1``,
    ``agent-hooks/draft`` is ``schema/draft``."""
    return _SCHEMA_DIR / require_spec_version(spec).removeprefix("agent-hooks/")


@functools.cache
def _load(spec: str, name: str) -> dict[str, Any]:
    return json.loads((schema_dir(spec) / name).read_text(encoding="utf-8"))


def per_point_schema(interception_point: str, spec: str) -> dict[str, Any]:
    """The closed per-point context schema of ``spec`` for one point."""
    return _load(spec, f"agent-context/{interception_point}.schema.json")


@functools.lru_cache(maxsize=8)
def per_point_registry(spec: str) -> Any:
    """Build a ``referencing.Registry`` so per-hook ``$ref: interception-point.schema.json``
    resolves against the vendored copy of ``spec``."""
    from referencing import Registry, Resource  # type: ignore[import-not-found]

    resources = []
    for p in schema_dir(spec).glob("*.schema.json"):
        doc = json.loads(p.read_text(encoding="utf-8"))
        resources.append((doc["$id"], Resource.from_contents(doc)))
        # Also register under the bare filename so relative $refs in the
        # generated per-hook schemas resolve.
        resources.append((p.name, Resource.from_contents(doc)))
    return Registry().with_resources(resources)
