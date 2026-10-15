# Copyright (c) Microsoft. All rights reserved.

import json
from pathlib import Path

import pytest
from agent_hooks import AgentHooksCoreError, Decision, InterceptorResponse, canonical_json

FIXTURE = json.loads(
    (Path(__file__).parents[3] / "conformance" / "golden" / "interceptor-response.json").read_text()
)


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_shared_valid_responses(case: dict[str, str]) -> None:
    response = InterceptorResponse.parse(case["input"])
    assert response.verdict.decision in Decision
    assert json.loads(
        json.dumps(
            {
                "verdict": response.verdict.to_wire(),
                **({"extensions": response.extensions} if response.extensions else {}),
            },
            separators=(",", ":"),
        )
    ) == json.loads(case["normalized"])
    assert InterceptorResponse.parse(response.to_wire()) == response


@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda case: case["name"])
def test_shared_invalid_responses(case: dict[str, str]) -> None:
    with pytest.raises(AgentHooksCoreError) as error:
        InterceptorResponse.parse(case["input"])
    assert error.value.code == FIXTURE["invalid_error"]


@pytest.mark.parametrize("case", FIXTURE["metadata_bounds"], ids=lambda case: case["name"])
def test_metadata_boundaries(case: dict) -> None:
    extensions = {"provider": {"receipt": {"p": "x" * case["padding"]}}}
    if case["second_provider"]:
        extensions["second"] = {}
    value = {"verdict": {"decision": "allow"}, "extensions": extensions}
    size = len(canonical_json(extensions).encode())
    assert size == case["bytes"]
    if case["valid"]:
        InterceptorResponse.parse(value)
    else:
        with pytest.raises(AgentHooksCoreError) as error:
            InterceptorResponse.parse(value)
        assert error.value.code == FIXTURE["invalid_error"]


def test_serialization_prefers_bare_verdict_without_metadata() -> None:
    response = InterceptorResponse.parse({"decision": "allow"})
    assert response.to_wire() == {"decision": "allow"}
    assert InterceptorResponse.parse(
        {"verdict": {"decision": "allow"}, "extensions": {}}
    ).to_wire() == {"decision": "allow"}
