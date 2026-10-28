# Copyright (c) Microsoft. All rights reserved.

"""Checked builders for the JSON Schema 2020-12 subset the schemas use.

Every builder returns a plain dict whose members sit in the order the call
names them. The committed schema files carry that order, so a fixed
emission order would change their bytes; the source keeps the order and
the emitter writes it out unchanged.

Each keyword is checked against the vocabulary below and each value
against the type the keyword takes, first when a builder runs and again
over the whole tree when ``document`` assembles a root. A typo such as
``additionalProperites`` or a ``required`` list holding a non-string
fails at generation time; the tree check names the node by JSON pointer.

Keywords that are not Python identifiers take an alias: ``ref`` for
``$ref``, ``defs`` for ``$defs``, ``not_``, ``if_`` and ``else_`` for the
reserved words.
"""

from __future__ import annotations

from typing import Callable

Schema = dict[str, object]

DRAFT = "https://json-schema.org/draft/2020-12/schema"
ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/v0.1/"

#: The boolean schema that accepts any JSON value.
ANY = True

_ALIASES = {"ref": "$ref", "defs": "$defs", "not_": "not", "if_": "if", "else_": "else"}


class SchemaError(ValueError):
    """A node uses a keyword outside the vocabulary or a value of the wrong type."""


def _is_str(value: object) -> bool:
    return isinstance(value, str)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_bool(value: object) -> bool:
    return isinstance(value, bool)


def _is_scalar(value: object) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _is_schema(value: object) -> bool:
    return isinstance(value, (dict, bool))


def _is_type(value: object) -> bool:
    return _is_str(value) or _is_strings(value)


def _is_strings(value: object) -> bool:
    return isinstance(value, list) and all(_is_str(v) for v in value)


def _is_scalars(value: object) -> bool:
    return isinstance(value, list) and all(_is_scalar(v) for v in value)


def _is_schemas(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(v, dict) for v in value)


def _is_schema_map(value: object) -> bool:
    return isinstance(value, dict) and all(
        _is_str(k) and _is_schema(v) for k, v in value.items()
    )


#: keyword -> predicate over its value.
KEYWORDS: dict[str, Callable[[object], bool]] = {
    "$id": _is_str,
    "$schema": _is_str,
    "$ref": _is_str,
    "$defs": _is_schema_map,
    "title": _is_str,
    "description": _is_str,
    "type": _is_type,
    "enum": _is_scalars,
    "const": _is_scalar,
    "default": _is_scalar,
    "format": _is_str,
    "pattern": _is_str,
    "minLength": _is_int,
    "maxLength": _is_int,
    "minimum": _is_int,
    "maximum": _is_int,
    "properties": _is_schema_map,
    "required": _is_strings,
    "additionalProperties": _is_schema,
    "propertyNames": _is_schema,
    "items": _is_schema,
    "minItems": _is_int,
    "maxItems": _is_int,
    "uniqueItems": _is_bool,
    "allOf": _is_schemas,
    "anyOf": _is_schemas,
    "oneOf": _is_schemas,
    "not": _is_schema,
    "if": _is_schema,
    "then": _is_schema,
    "else": _is_schema,
}

# Keywords whose value holds further schemas, by shape.
_ONE = {"additionalProperties", "propertyNames", "items", "not", "if", "then", "else"}
_LIST = {"allOf", "anyOf", "oneOf"}
_MAP = {"properties", "$defs"}


def validate(node: Schema, where: str = "#") -> None:
    """Check ``node`` and every schema below it against the vocabulary."""
    for key, value in node.items():
        check = KEYWORDS.get(key)
        if check is None:
            raise SchemaError(f"{where}: unknown keyword {key!r}")
        if not check(value):
            raise SchemaError(f"{where}/{key}: {value!r} is not a valid value")
        if key in _ONE and isinstance(value, dict):
            validate(value, f"{where}/{key}")
        elif key in _LIST:
            for index, sub in enumerate(value):
                validate(sub, f"{where}/{key}/{index}")
        elif key in _MAP:
            for name, sub in value.items():
                if isinstance(sub, dict):
                    validate(sub, f"{where}/{key}/{name}")


def schema(**members: object) -> Schema:
    """A schema object with exactly the given members, in call order."""
    node: Schema = {_ALIASES.get(key, key): value for key, value in members.items()}
    for key, value in node.items():
        check = KEYWORDS.get(key)
        if check is None:
            raise SchemaError(f"unknown keyword {key!r}")
        if not check(value):
            raise SchemaError(f"{key}: {value!r} is not a valid value")
    return node


def _typed(name: str, nullable: bool, members: dict[str, object]) -> Schema:
    return schema(type=[name, "null"] if nullable else name, **members)


def string(*, nullable: bool = False, **members: object) -> Schema:
    """``type: string``; ``nullable`` widens it to ``["string", "null"]``."""
    return _typed("string", nullable, members)


def integer(*, nullable: bool = False, **members: object) -> Schema:
    """``type: integer``; ``nullable`` widens it to ``["integer", "null"]``."""
    return _typed("integer", nullable, members)


def number(**members: object) -> Schema:
    """``type: number``."""
    return _typed("number", False, members)


def boolean(**members: object) -> Schema:
    """``type: boolean``."""
    return _typed("boolean", False, members)


def obj(**members: object) -> Schema:
    """``type: object``; pass ``additionalProperties=False`` to close it."""
    return _typed("object", False, members)


def array(*, nullable: bool = False, **members: object) -> Schema:
    """``type: array``; ``nullable`` widens it to ``["array", "null"]``."""
    return _typed("array", nullable, members)


def ref(target: str, **members: object) -> Schema:
    """``$ref`` to a sibling file (``verdict.schema.json``) or a local def."""
    return schema(ref=target, **members)


def const(value: object, **members: object) -> Schema:
    """``const``: exactly one permitted value, ``None`` for JSON null."""
    return schema(const=value, **members)


def document(name: str, *, title: str, description: str, body: Schema) -> Schema:
    """A root schema: ``$id`` under ``ID_BASE``, ``$schema``, title, description
    and then the members of ``body``. The whole tree is validated."""
    root: Schema = {
        "$id": f"{ID_BASE}{name}.schema.json",
        "$schema": DRAFT,
        "title": title,
        "description": description,
        **body,
    }
    validate(root)
    return root
