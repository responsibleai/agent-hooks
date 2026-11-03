#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/cut-spec-version.py, on a draft built
in a temporary directory."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_SPEC = importlib.util.spec_from_file_location(
    "cut_spec_version", Path(__file__).with_name("cut-spec-version.py")
)
assert MODULE_SPEC and MODULE_SPEC.loader
cut = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(cut)

DRAFT = """# Agent Hooks Specification — Draft

> **Draft:** This is the working text for the next specification version.
> It is not a released specification. The latest released version is
> [0.1](../0.1/AGENT-HOOKS-0.1.md).

> **Status:** Draft · **Version:** `DRAFT` · **Date:** 2026-11-03
> **Editors:** Someone

Every context carries `agent-hooks/0.1`. The schema is
`spec/draft/schema/generated/agent-context.schema.json`.
"""


class CutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        draft = self.root / "spec/draft"
        (draft / "schema/generated").mkdir(parents=True)
        (draft / "AGENT-HOOKS-DRAFT.md").write_text(DRAFT, encoding="utf-8")
        (draft / "DECLARATION-VERSIONS.md").write_text(
            "| 1.1 | `spec/draft/schema/generated/host-declaration-1.1.schema.json` |\n",
            encoding="utf-8",
        )
        (draft / "schema/generated/x.schema.json").write_text(
            '{"$id": "https://responsibleai.github.io/agent-hooks/schema/draft/x.schema.json"}\n',
            encoding="utf-8",
        )
        (draft / "reserved-reasons.json").write_text(
            '{"$id": "https://responsibleai.github.io/agent-hooks/schema/draft/reserved-reasons.json"}\n',
            encoding="utf-8",
        )
        (draft / "schema/src").mkdir()
        (draft / "schema/src/agent-context.ts").write_text(
            "/** The wire version agent-hooks/0.1 (§4.1). */\n", encoding="utf-8"
        )
        (draft / "schema/examples/AgentContext").mkdir(parents=True)
        (draft / "schema/examples/AgentContext/input.json").write_text(
            '{"spec": "agent-hooks/0.1", "interception_point": "input"}\n',
            encoding="utf-8",
        )
        (self.root / "spec/0.1").mkdir()

    def test_cut_writes_the_released_copy_and_updates_the_draft(self) -> None:
        follow_ups = cut.cut(self.root, "0.2", "2026-12-01")
        released = (self.root / "spec/0.2/AGENT-HOOKS-0.2.md").read_text(
            encoding="utf-8"
        )
        self.assertEqual(
            released,
            """# Agent Hooks Specification — Version 0.2

> **Status:** Released · **Version:** `0.2` · **Date:** 2026-12-01
> **Editors:** Someone

Every context carries `agent-hooks/0.2`. The schema is
`spec/0.2/schema/generated/agent-context.schema.json`.
""",
        )
        self.assertFalse((self.root / "spec/0.2/AGENT-HOOKS-DRAFT.md").exists())
        self.assertIn(
            "`spec/0.2/schema/generated/host-declaration-1.1.schema.json`",
            (self.root / "spec/0.2/DECLARATION-VERSIONS.md").read_text(
                encoding="utf-8"
            ),
        )
        self.assertEqual(
            (self.root / "spec/0.2/schema/generated/x.schema.json").read_text(
                encoding="utf-8"
            ),
            '{"$id": "https://responsibleai.github.io/agent-hooks/schema/v0.2/x.schema.json"}\n',
        )
        self.assertEqual(
            (self.root / "spec/0.2/reserved-reasons.json").read_text(encoding="utf-8"),
            '{"$id": "https://responsibleai.github.io/agent-hooks/schema/v0.2/reserved-reasons.json"}\n',
        )
        for folder in ("0.2", "draft"):
            self.assertEqual(
                (
                    self.root
                    / "spec"
                    / folder
                    / "schema/examples/AgentContext/input.json"
                ).read_text(encoding="utf-8"),
                '{"spec": "agent-hooks/0.2", "interception_point": "input"}\n',
                folder,
            )
            self.assertEqual(
                (self.root / "spec" / folder / "schema/src/agent-context.ts").read_text(
                    encoding="utf-8"
                ),
                "/** The wire version agent-hooks/0.2 (§4.1). */\n",
                folder,
            )
        self.assertEqual(
            (self.root / "spec/draft/schema/generated/x.schema.json").read_text(
                encoding="utf-8"
            ),
            '{"$id": "https://responsibleai.github.io/agent-hooks/schema/draft/x.schema.json"}\n',
        )
        draft = (self.root / "spec/draft/AGENT-HOOKS-DRAFT.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("`agent-hooks/0.2`", draft)
        self.assertIn("**Version:** `DRAFT`", draft)
        self.assertIn("spec/draft/schema/generated", draft)
        self.assertTrue(any("--check --spec 0.2" in step for step in follow_ups))
        self.assertTrue(
            any("spec/0.2" in step and "tag" in step for step in follow_ups)
        )

    def test_refuses_bad_versions_dates_and_existing_folders(self) -> None:
        for version in ("0.2.0", "02.1", "draft", "0.١"):
            with self.assertRaises(SystemExit):
                cut.cut(self.root, version, "2026-12-01")
        with self.assertRaises(SystemExit):
            cut.cut(self.root, "0.2", "2026-12-1")
        with self.assertRaises(SystemExit):
            cut.cut(self.root, "0.1", "2026-12-01")
        self.assertFalse((self.root / "spec/0.2").exists())

    def test_refuses_a_draft_without_banner_or_header(self) -> None:
        with self.assertRaises(SystemExit):
            cut.released_text(
                "# Agent Hooks Specification — Draft\n\nno banner\n",
                "0.2",
                "2026-12-01",
            )
        with self.assertRaises(SystemExit):
            cut.released_text(
                "# Agent Hooks Specification — Draft\n\n> **Draft:** x\n\ntext\n",
                "0.2",
                "2026-12-01",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
