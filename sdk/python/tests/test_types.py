# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Unit tests for §5 verdict validation and §3 interception-point properties."""

from __future__ import annotations

import pytest
from agent_hooks import Decision, HostError, InterceptionPoint, Transform, Verdict, Warning


class TestInterceptionPoint:
    def test_eight_values(self) -> None:
        assert len(InterceptionPoint) == 8

    @pytest.mark.parametrize("hp", list(InterceptionPoint))
    def test_transform_permitted(self, hp: InterceptionPoint) -> None:
        forbidden = {InterceptionPoint.AGENT_STARTUP, InterceptionPoint.AGENT_SHUTDOWN}
        assert hp.transform_permitted == (hp not in forbidden)


class TestVerdict:
    def test_three_decisions(self) -> None:
        # §5.1: the closed set is three — warn is allow+warnings,
        # escalate is deny+approval.
        assert len(Decision) == 3
        assert {d.value for d in Decision} == {"allow", "deny", "transform"}

    def test_allow_constant(self) -> None:
        from agent_hooks import ALLOW

        assert ALLOW.decision is Decision.ALLOW
        assert ALLOW.decision.permits

    def test_transform_requires_body(self) -> None:
        with pytest.raises(ValueError, match="REQUIRED"):
            Verdict(decision=Decision.TRANSFORM)

    def test_transform_forbidden_on_allow(self) -> None:
        with pytest.raises(ValueError, match="FORBIDDEN"):
            Verdict(decision=Decision.ALLOW, transform=Transform("$target.x", 1))

    def test_approval_only_on_deny(self) -> None:
        with pytest.raises(ValueError, match="approval"):
            Verdict(decision=Decision.ALLOW, approval={})
        v = Verdict(decision=Decision.DENY, approval={})
        assert v.is_liftable
        assert not Verdict(decision=Decision.DENY).is_liftable

    def test_allow_sugar_is_trivial_permit(self) -> None:
        from agent_hooks import ALLOW

        v = Verdict.allow()
        assert v.decision is Decision.ALLOW
        assert v == ALLOW
        assert v.warnings == ()
        assert v.approval is None
        assert not v.is_liftable

    def test_warn_sugar_is_allow_with_warning(self) -> None:
        v = Verdict.warn(reason="pii", message="found ssn")
        assert v.decision is Decision.ALLOW
        assert v.warnings == (Warning(reason="pii", message="found ssn"),)
        assert not v.is_liftable

    def test_deny_sugar_is_final_deny(self) -> None:
        v = Verdict.deny(reason="policy", message="blocked")
        assert v.decision is Decision.DENY
        assert v.reason == "policy"
        assert v.message == "blocked"
        assert v.approval is None
        assert not v.is_liftable

    def test_escalate_sugar_is_liftable_deny(self) -> None:
        v = Verdict.escalate(reason="check")
        assert v.decision is Decision.DENY
        assert v.approval == {}
        assert v.is_liftable

    def test_interceptor_cannot_emit_host_error_reason(self) -> None:
        with pytest.raises(ValueError, match="host_error"):
            Verdict(decision=Decision.DENY, reason="host_error:nope")

    def test_host_error_factory_bypasses_check(self) -> None:
        v = Verdict.host_error(HostError.INTERCEPTOR_FAILED)
        assert v.decision is Decision.DENY
        assert v.reason == "host_error:interceptor_failed"
        assert not v.is_liftable

    def test_host_error_liftable(self) -> None:
        # §7.5 "approval" knob value: the failure is consultable.
        v = Verdict.host_error(HostError.TRANSFORM_CONFLICT, liftable=True)
        assert v.is_liftable

    def test_from_wire_roundtrip(self) -> None:
        wire = {
            "decision": "transform",
            "reason": "redact",
            "transform": {"path": "$target.url", "value": "x"},
            "result_labels": ["pii"],
        }
        v = Verdict.from_wire(wire)
        assert v.decision is Decision.TRANSFORM
        assert v.transform.path == "$target.url"
        assert v.to_wire()["transform"]["value"] == "x"

    def test_from_wire_warnings_roundtrip(self) -> None:
        v = Verdict.from_wire(
            {"decision": "allow", "warnings": [{"reason": "pii", "message": "m"}]}
        )
        assert v.warnings == (Warning(reason="pii", message="m"),)
        assert v.to_wire()["warnings"] == [{"reason": "pii", "message": "m"}]

    def test_from_wire_liftable_deny(self) -> None:
        assert Verdict.from_wire({"decision": "deny", "approval": {}}).is_liftable
        assert not Verdict.from_wire({"decision": "deny"}).is_liftable

    def test_from_wire_rejects_bad_decision(self) -> None:
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": "maybe"})

    @pytest.mark.parametrize("removed", ["warn", "escalate"])
    def test_from_wire_rejects_removed_decisions(self, removed: str) -> None:
        # §5.1: warn and escalate are not wire decisions anymore.
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": removed})

    def test_from_wire_rejects_bad_warnings(self) -> None:
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": "allow", "warnings": ["x"]})
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": "allow", "warnings": [{"reason": "host_error:x"}]})

    def test_from_wire_rejects_approval_on_permit(self) -> None:
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": "allow", "approval": {}})
        with pytest.raises(ValueError):
            Verdict.from_wire({"decision": "deny", "approval": []})


class TestTransform:
    def test_rejects_foreign_root(self) -> None:
        with pytest.raises(ValueError):
            Transform(path="$snapshot.x", value=1)

    def test_accepts_policy_target_alias(self) -> None:
        Transform(path="$policy_target.x", value=1)
