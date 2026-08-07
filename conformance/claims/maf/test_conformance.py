# Copyright (c) 2026 MohammadHaroonAbuomar. MIT License.
"""AGENT-HOOKS-0.1 CTK conformance run for Microsoft Agent Framework.

Run with::

    pytest test_conformance.py \
        --agent-hooks-harness=harness:AgentFrameworkHarness \
        --agent-hooks-vectors=/path/to/conformance/vectors

Omitting ``--agent-hooks-vectors`` uses the vector set vendored in the
``agent-hooks-sdk`` wheel (the claimed corpus).
"""

import warnings

# The middleware factories are @experimental in agent-framework-core; the
# warning is expected and not part of the conformance surface.
warnings.filterwarnings("ignore", module=r"agent_framework.*", category=UserWarning)


def test_conformance(agent_hooks_assert):  # noqa: ANN001
    """One parametrized case per AH-CTK vector (pass / fail / capability-gated skip)."""
