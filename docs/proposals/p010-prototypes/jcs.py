# Copyright (c) Microsoft. All rights reserved.

"""RFC 8785 canonical JSON for the value domain these fixtures use (objects,
arrays, strings, integers, booleans, null). Member names sort by UTF-16 code
units, which equals code point order for the names used here. Floats are
rejected on purpose: the fixtures carry none, and ECMA-262 number formatting
is not reimplemented. When the ``agent_hooks`` package with its Rust core is
importable, ``cross_check`` compares both outputs byte for byte."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _check(value: Any) -> None:
    if isinstance(value, float):
        raise TypeError("floats are outside this helper's value domain")
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError("member names must be strings")
            _check(v)
    elif isinstance(value, list):
        for v in value:
            _check(v)


def _sort_key(name: str) -> list[int]:
    units: list[int] = []
    for ch in name:
        cp = ord(ch)
        if cp >= 0x10000:
            cp -= 0x10000
            units += [0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)]
        else:
            units.append(cp)
    return units


def _canon(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _canon(value[k]) for k in sorted(value, key=_sort_key)}
    if isinstance(value, list):
        return [_canon(v) for v in value]
    return value


def canonical_json(value: Any) -> str:
    _check(value)
    return json.dumps(_canon(value), ensure_ascii=False, separators=(",", ":"))


def size(value: Any) -> int:
    return len(canonical_json(value).encode("utf-8"))


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def cross_check(values: list[Any]) -> str:
    try:
        from agent_hooks.canonical import canonical_json as core_canonical  # type: ignore
    except Exception:  # noqa: BLE001 - optional dependency
        return "agent_hooks core not importable; pure-Python canonicalization used"
    for v in values:
        if core_canonical(v) != canonical_json(v):
            return "MISMATCH between the Rust core and the pure-Python helper"
    return f"cross-checked {len(values)} objects against the agent_hooks Rust core: identical bytes"
