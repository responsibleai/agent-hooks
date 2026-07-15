# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""``$target`` JSONPath subset: parse, resolve, apply transforms (§5.2).

Delegates to the Rust core (``agent_hooks._core``). The parse/resolve
helpers remain pure-Python for callers that need segment introspection
without a JSON round-trip; ``apply`` — the security-relevant path — goes
through the core so behaviour is identical across SDKs.
"""

from __future__ import annotations

import json
import re
from typing import Any

from agent_hooks import _core
from agent_hooks._marshal import dumps
from agent_hooks._types import HostError

_ROOT_RE = re.compile(r"^\$(target|policy_target)")
_SEGMENT_RE = re.compile(
    r"""
    \.(?P<dot>[A-Za-z0-9_-]+)          # .member
  | \[(?P<idx>\d+)\]                   # [index]
  | \["(?P<bkt>[A-Za-z0-9_-]+)"\]      # ["member"]
    """,
    re.VERBOSE,
)


class PathError(ValueError):
    """A transform path failed to parse or resolve."""

    def __init__(self, host_error: HostError, detail: str) -> None:
        self.host_error = host_error
        super().__init__(f"{host_error.value}: {detail}")


def parse(path: str) -> list[str | int]:
    """Parse a §5.2 path into segments. Raises :class:`PathError`.

    Local implementation retained for introspection only; the grammar is
    identical to ``sdk/rust/core/src/path.rs``.
    """
    m = _ROOT_RE.match(path)
    if not m:
        raise PathError(
            HostError.TRANSFORM_TARGET_FORBIDDEN,
            f"path must be rooted at $target (got {path!r})",
        )
    pos = m.end()
    segs: list[str | int] = []
    while pos < len(path):
        sm = _SEGMENT_RE.match(path, pos)
        if not sm:
            raise PathError(HostError.TRANSFORM_INVALID, f"unparseable segment at {path[pos:]!r}")
        if sm.group("dot") is not None:
            segs.append(sm.group("dot"))
        elif sm.group("idx") is not None:
            segs.append(int(sm.group("idx")))
        else:
            segs.append(sm.group("bkt"))
        pos = sm.end()
    return segs


def resolve(target: Any, path: str) -> Any:
    """Return the value at ``path`` within ``target``."""
    cur = target
    for seg in parse(path):
        try:
            cur = cur[seg]
        except (KeyError, IndexError, TypeError) as e:
            raise PathError(
                HostError.TRANSFORM_INVALID, f"segment {seg!r} did not resolve: {e}"
            ) from e
    return cur


def apply(target: Any, path: str, value: Any) -> Any:
    """Return ``target`` with the value at ``path`` replaced by ``value``.

    Delegates to the Rust core. Returns a new object (deep copy semantics
    across the FFI boundary); ``target`` is not mutated.
    """
    try:
        out = _core.apply_transform(dumps(target), path, dumps(value))
    except _core.AgentHooksCoreError as e:
        code = getattr(e, "code", HostError.TRANSFORM_INVALID.value)
        raise PathError(HostError(code), str(e)) from e
    return json.loads(out)
