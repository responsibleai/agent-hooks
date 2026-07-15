# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""FFI marshalling guard (§4.4, §10.2).

Every context/verdict value crossing into ``agent_hooks._core`` is
serialized through :func:`dumps`, which sets ``allow_nan=False`` so a
non-finite number (``nan``/``inf``) raises :class:`ValueError` at the
boundary instead of leaking Python's non-standard ``NaN`` literal into
wire JSON. The emitter maps that failure to a fail-closed
``host_error:context_invalid`` deny (§10.2: fail closed, never
normalize).
"""

from __future__ import annotations

import json
from typing import Any


def dumps(obj: Any) -> str:
    """``json.dumps`` restricted to RFC 8259 JSON (no NaN/Infinity)."""
    return json.dumps(obj, allow_nan=False)
