# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""The README's host declaration example loads with the registry the
README builds next to it. The schema alone cannot catch a surface the
snippet's registry lacks (§7.7.4), so this test runs the two snippets
together through the loader.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

import pytest
from agent_hooks import (
    ApprovalOutcome,
    ApprovalRequest,
    ApprovalResolution,
    BindingContext,
    HostRegistry,
    HostSurface,
    InterceptionEmitter,
    Verdict,
)
from agent_hooks.context import AgentContext

_README = pathlib.Path(__file__).resolve().parents[3] / "README.md"

pytestmark = pytest.mark.skipif(not _README.is_file(), reason="repository README not present")


class AllowAll:
    def intercept(self, _ctx: AgentContext) -> Verdict:
        return Verdict.allow()


class Approver:
    def resolve(self, request: ApprovalRequest) -> ApprovalResolution:
        return ApprovalResolution(
            outcome=ApprovalOutcome.APPROVE,
            context_identity=request.context_identity,
            verdict=Verdict.allow(),
        )


def _blocks(lang: str) -> list[str]:
    text = _README.read_text(encoding="utf-8")
    return re.findall(rf"```{lang}\n(.*?)```", text, flags=re.DOTALL)


def _snippet_names(snippet: str, call: str) -> list[str]:
    return re.findall(rf"\.{call}\(\s*\"([^\"]+)\"", snippet)


def test_readme_declaration_loads_with_readme_registry() -> None:
    documents = [b for b in _blocks("json") if '"declaration":' in b]
    assert len(documents) == 1, "the README shows one host declaration"
    document = documents[0]
    json.loads(document)

    snippets = [b for b in _blocks("python") if "HostSurface.from_capabilities" in b]
    assert len(snippets) == 1, "the README shows one registry snippet"
    snippet = snippets[0]

    match = re.search(r"from_capabilities\(\s*\[(.*?)\]\s*\)", snippet, flags=re.DOTALL)
    assert match is not None
    capabilities = re.findall(r"\"([^\"]+)\"", match.group(1))
    kinds = _snippet_names(snippet, "kind")
    resolvers = _snippet_names(snippet, "approval_resolver")
    redactors = _snippet_names(snippet, "approval_redactor")
    assert kinds and resolvers and redactors

    def make(_config: Any, _ctx: BindingContext) -> AllowAll:
        return AllowAll()

    registry = HostRegistry(HostSurface.from_capabilities(capabilities))
    for kind in kinds:
        registry = registry.kind(kind, make)
    for name in resolvers:
        registry = registry.approval_resolver(name, Approver())
    for name in redactors:
        registry = registry.approval_redactor(name, lambda ctx: ctx)

    emitter = InterceptionEmitter.from_declaration_json(document, registry)
    resolved = emitter.declaration
    assert resolved is not None
    wire = resolved.to_wire()
    assert wire["declaration"] == json.loads(document)["declaration"]
    assert [b["id"] for b in wire["bindings"]] == [
        b["id"] for b in json.loads(document)["bindings"]
    ]
