# Copyright (c) Microsoft. All rights reserved.

"""The generated wire contract works independently of the native SDK."""

import subprocess
import sys
from typing import get_args, get_type_hints

from agent_hooks_contracts.generated import draft as contract
from typing_extensions import is_typeddict


def test_contract_import_does_not_load_native_sdk() -> None:
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import agent_hooks_contracts.generated.draft; "
            "assert not any(n == 'agent_hooks' or n.startswith('agent_hooks.') "
            "for n in sys.modules)",
        ],
        check=True,
    )


def test_union_arguments_are_runtime_types() -> None:
    assert get_args(contract.AgentContext) == (
        contract.AgentStartupRequest,
        contract.InputRequest,
        contract.PreModelCallRequest,
        contract.PostModelCallRequest,
        contract.PreToolCallRequest,
        contract.PostToolCallRequest,
        contract.OutputRequest,
        contract.AgentShutdownRequest,
    )
    assert get_args(contract.ApprovalResolution) == (
        contract.ApproveResolution,
        contract.RejectResolution,
        contract.UnresolvedResolution,
    )
    assert get_args(contract.Surface) == (contract.BufferedSurface, contract.UnbufferedSurface)


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
