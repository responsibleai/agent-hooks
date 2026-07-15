# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Canonical JSON serialization and context identity (§10).

Delegates to the Rust core (``agent_hooks._core``) so every SDK produces
byte-identical output. The pure-Python implementation was removed once the
core became canonical (see ``sdk/rust/core/src/canonical.rs``).
"""

from __future__ import annotations

from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps


def canonical_json(obj: Any) -> str:
    """Serialize ``obj`` per §10.1: lexicographic keys, no whitespace,
    ECMA-262 numbers, RFC 8259 minimal string escapes.

    Implemented by the Rust core; this shim only marshals ``obj`` to a
    JSON string for the FFI boundary (``allow_nan=False``, §4.4).
    """
    return _core.canonical_json(dumps(obj))


def context_identity(ctx: dict[str, Any]) -> str:
    """``"sha256:" + hex(SHA-256(canonical_json(ctx_rc)))`` (§10.2).

    Implemented by the Rust core; fails closed
    (``host_error:context_invalid`` with remediation detail) on a
    non-I-JSON projection, e.g. an integral number beyond ±(2^53−1).
    """
    return _core.context_identity(dumps(ctx))
