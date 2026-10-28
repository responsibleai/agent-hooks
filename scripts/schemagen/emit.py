# Copyright (c) Microsoft. All rights reserved.

"""Serializers that reproduce the committed files byte for byte.

Three layouts exist in ``spec/schema/``:

* ``plain``: ``json.dumps(indent=2, ensure_ascii=False)``, the layout of
  seven root files.
* ``ascii_escaped``: ``json.dumps(indent=2)`` with non-ASCII escaped, the
  layout the per-point files have carried since their first generator.
* ``compact``: the hand layout of ``agent-context.schema.json``. Arrays
  of scalars and small objects sit on one line; everything else is one
  member per line. ``Layout`` pins the places where the file departs
  from that rule, so the output stays byte-identical to the file as
  committed. Reformatting the file to ``plain`` retires the pins.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

from .vocabulary import Schema

Style = Callable[[Schema], str]


def plain(doc: Schema) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def ascii_escaped(doc: Schema) -> str:
    return json.dumps(doc, indent=2) + "\n"


@dataclass(frozen=True)
class Layout:
    """Departures from the compact rule, as JSON pointers into the document."""

    #: Containers written one member per line though the rule puts them on one.
    expanded: frozenset[str] = frozenset()
    #: Members followed by one blank line.
    blank_after: frozenset[str] = frozenset()


def compact(layout: Layout) -> Style:
    def style(doc: Schema) -> str:
        return _emit(doc, "", "", 0, layout) + "\n"

    return style


def _scalar(value: object) -> bool:
    return not isinstance(value, (dict, list))


def _pointer(parent: str, key: object) -> str:
    return f"{parent}/{str(key).replace('~', '~0').replace('/', '~1')}"


def _one_line(key: str, value: object, pointer: str, layout: Layout) -> bool:
    """The compact rule: an array of scalars, or an object with at most two
    members of which at most one is a container that is itself on one line.
    A ``properties`` map is on one line only when its single entry is a
    scalar or a schema of scalars; otherwise it lists one property per line."""
    if pointer in layout.expanded:
        return False
    if isinstance(value, list):
        return all(_scalar(v) for v in value)
    assert isinstance(value, dict)
    nested = [(k, v) for k, v in value.items() if not _scalar(v)]
    if len(value) > 2 or len(nested) > 1:
        return False
    if not nested:
        return True
    ((child_key, child),) = nested
    if not _one_line(child_key, child, _pointer(pointer, child_key), layout):
        return False
    if key == "properties":
        values = child.values() if isinstance(child, dict) else child
        return len(value) == 1 and all(_scalar(v) for v in values)
    return True


def _text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _emit(value: object, key: str, pointer: str, depth: int, layout: Layout) -> str:
    if _scalar(value):
        return _text(value)
    if len(value) == 0:
        return "[]" if isinstance(value, list) else "{}"
    if _one_line(key, value, pointer, layout):
        if isinstance(value, list):
            return "[" + ", ".join(_text(v) for v in value) + "]"
        parts = [
            f"{_text(k)}: {_emit(v, k, _pointer(pointer, k), depth, layout)}"
            for k, v in value.items()
        ]
        return "{ " + ", ".join(parts) + " }"
    pad = "  " * (depth + 1)
    close = "  " * depth
    if isinstance(value, list):
        items = [
            pad + _emit(v, str(i), _pointer(pointer, i), depth + 1, layout)
            for i, v in enumerate(value)
        ]
        return "[\n" + ",\n".join(items) + "\n" + close + "]"
    out = "{\n"
    members = list(value.items())
    for index, (k, v) in enumerate(members):
        child = _pointer(pointer, k)
        out += f"{pad}{_text(k)}: {_emit(v, k, child, depth + 1, layout)}"
        if index < len(members) - 1:
            out += ",\n\n" if child in layout.blank_after else ",\n"
    return out + "\n" + close + "}"
