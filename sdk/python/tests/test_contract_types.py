# Copyright (c) Microsoft. All rights reserved.

"""The generated wire contract works independently of the native SDK."""

import json
import subprocess
import sys
from typing import get_type_hints

import agent_hooks_contract as contract
from typing_extensions import is_typeddict


def test_contract_import_does_not_load_native_sdk() -> None:
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import agent_hooks_contract; "
            "assert not any(n == 'agent_hooks' or n.startswith('agent_hooks.') "
            "for n in sys.modules)",
        ],
        check=True,
    )


def test_contract_json_preserves_wire_values() -> None:
    response: contract.PreToolHookResponse = {
        "verdict": {
            "decision": "transform",
            "transform": {"args": {"large": 2**80, "nested": [None, True, {"text": "hello"}]}},
        },
        "extensions": {"example": {"reviewed": True}},
    }
    assert json.loads(json.dumps(response)) == response
    assert "reason" not in response["verdict"]


def test_forward_references_and_key_presence() -> None:
    for model in vars(contract).values():
        if is_typeddict(model):
            get_type_hints(model)

    # NotRequired must remain visible at runtime, even for forward references.
    assert "params" in contract.Model.__optional_keys__
    assert "content" in contract.Input.__required_keys__
    assert "content" not in contract.Input.__optional_keys__
    assert "$schema" in contract.HostDeclaration.__optional_keys__
    assert "spec" in contract.HostDeclaration.__required_keys__
