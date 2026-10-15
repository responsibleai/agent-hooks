# Copyright (c) Microsoft. All rights reserved.

"""Optional hosted/cross-process interceptor response envelope (§5.5)."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any

from agent_hooks import _core
from agent_hooks._types import Verdict


@dataclass(frozen=True, slots=True)
class InterceptorResponse:
    """A canonical Verdict plus optional opaque transport response data (§5.5)."""

    verdict: Verdict
    extensions: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, value: str | dict[str, Any]) -> InterceptorResponse:
        """Parse a bare Verdict or response envelope through the Rust gate.

        Pass raw JSON text when duplicate-member detection is required.
        """

        text = (
            value
            if isinstance(value, str)
            else json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        )
        normalized = json.loads(_core.normalize_interceptor_response(text))
        verdict = normalized["verdict"]
        if verdict["decision"] == "transform":
            verdict["transform"].setdefault("value", None)
        return cls(
            verdict=Verdict.from_wire(verdict),
            extensions=copy.deepcopy(normalized.get("extensions") or {}),
        )

    def to_wire(self) -> dict[str, Any]:
        """Emit bare Verdict when no transport metadata is present."""

        if not self.extensions:
            return self.verdict.to_wire()
        return {
            "verdict": self.verdict.to_wire(),
            "extensions": copy.deepcopy(self.extensions),
        }
