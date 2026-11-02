#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/stage-docs-site.py.

Each case stages a small repository tree with several released bundles
and a draft, built in a temporary directory.
"""

import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

MODULE_SPEC = importlib.util.spec_from_file_location(
    "stage_docs_site", Path(__file__).with_name("stage-docs-site.py")
)
assert MODULE_SPEC and MODULE_SPEC.loader
stage = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(stage)

ID_BASE = "https://responsibleai.github.io/agent-hooks/schema/"
MKDOCS = """site_name: test
nav:
  - Home: index.md
  # The Specification entries are regenerated at build time.
  - Specification:
      - "0.0.1": spec/0.0.1.md
      - Draft: spec-draft.md
  - FAQ: faq.md
"""


def schema(identity: str, marker: str) -> str:
    return json.dumps({"$id": ID_BASE + identity, "title": marker}) + "\n"


def bundle(
    root: Path, version: str, wire: str, marker: str, inventory: str | None = None
) -> None:
    """A bundle whose schemas publish under <wire> and carry <marker>;
    its inventories name <inventory>, by default the version."""
    folder = root / "spec" / version
    (folder / "schema/generated/strict-contexts").mkdir(parents=True)
    (folder / "AGENT-HOOKS-0.1.md").write_text(f"# spec {version}\n", encoding="utf-8")
    for name in stage.INVENTORIES:
        (folder / name).write_text(
            json.dumps({"from": inventory or version}), encoding="utf-8"
        )
    (folder / "schema/generated/agent-context.schema.json").write_text(
        schema(f"{wire}/agent-context.schema.json", marker), encoding="utf-8"
    )
    (folder / "schema/generated/strict-contexts/input.schema.json").write_text(
        schema(f"{wire}/agent-context/input.schema.json", marker), encoding="utf-8"
    )


class StageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        bundle(self.root, "0.1.0", "v0.1", "first")
        # 0.1.1 keeps the v0.1 path with byte-identical files, which is allowed.
        bundle(self.root, "0.1.1", "v0.1", "first", inventory="0.1.0")
        bundle(self.root, "0.2.0", "v0.2", "second")
        # 0.10.0 sorts after 0.2.0 numerically, not lexically.
        bundle(self.root, "0.10.0", "v0.10", "tenth")
        draft = self.root / "spec/draft"
        draft.mkdir()
        (draft / "AGENT-HOOKS-0.1.md").write_text(
            "> The current one is [0.10.0](../0.10.0/AGENT-HOOKS-0.1.md).\n# draft\n",
            encoding="utf-8",
        )
        (self.root / "conformance").mkdir()
        (self.root / "conformance/vectors.schema.json").write_text(
            schema("v0.1/conformance/vectors.schema.json", "vectors"), encoding="utf-8"
        )
        (self.root / "docs-site/docs").mkdir(parents=True)
        (self.root / "docs-site/mkdocs.yml").write_text(MKDOCS, encoding="utf-8")
        self.docs = self.root / "docs-site/docs"

    def read(self, relative: str) -> str:
        return (self.docs / relative).read_text(encoding="utf-8")

    def test_versions_are_ordered_numerically_newest_first(self) -> None:
        self.assertEqual(stage.stage(self.root), ["0.10.0", "0.2.0", "0.1.1", "0.1.0"])

    def test_one_page_per_version_and_the_latest_alias(self) -> None:
        for version in stage.stage(self.root):
            self.assertEqual(self.read(f"spec/{version}.md"), f"# spec {version}\n")
        self.assertEqual(self.read("spec.md"), "# spec 0.10.0\n")

    def test_draft_back_link_points_at_the_version_page(self) -> None:
        stage.stage(self.root)
        self.assertEqual(
            self.read("spec-draft.md"),
            "> The current one is [0.10.0](spec/0.10.0.md).\n# draft\n",
        )

    def test_schemas_and_inventories_land_at_their_id_paths(self) -> None:
        stage.stage(self.root)
        self.assertEqual(
            json.loads(self.read("schema/v0.1/agent-context.schema.json"))["title"],
            "first",
        )
        self.assertEqual(
            json.loads(self.read("schema/v0.1/agent-context/input.schema.json"))[
                "title"
            ],
            "first",
        )
        self.assertEqual(
            json.loads(self.read("schema/v0.2/agent-context.schema.json"))["title"],
            "second",
        )
        self.assertEqual(
            json.loads(self.read("schema/v0.10/agent-context.schema.json"))["title"],
            "tenth",
        )
        for name in (
            "reserved-reasons.json",
            "reserved-warnings.json",
            "declaration-errors.json",
        ):
            self.assertEqual(
                json.loads(self.read(f"schema/v0.1/{name}")), {"from": "0.1.0"}
            )
            self.assertEqual(
                json.loads(self.read(f"schema/v0.10/{name}")), {"from": "0.10.0"}
            )
        self.assertEqual(
            json.loads(self.read("schema/v0.1/conformance/vectors.schema.json"))[
                "title"
            ],
            "vectors",
        )
        self.assertFalse((self.docs / "schema/strict-contexts").exists())

    def test_a_shared_path_with_different_bytes_fails(self) -> None:
        bundle(self.root, "0.1.2", "v0.1", "changed", inventory="0.1.0")
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        message = str(raised.exception)
        self.assertIn(
            "spec/0.1.2 and spec/0.1.1 both publish schema/v0.1/agent-context.schema.json",
            message,
        )
        self.assertIn("ID_BASE", message)

    def test_a_shared_path_with_different_inventories_fails(self) -> None:
        bundle(self.root, "0.1.2", "v0.1", "first")
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("schema/v0.1/reserved-reasons.json", str(raised.exception))

    def test_symbolic_links_fail(self) -> None:
        generated = self.root / "spec/0.2.0/schema/generated"
        os.symlink("agent-context.schema.json", generated / "copy.schema.json")
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("copy.schema.json is a symbolic link", str(raised.exception))
        os.unlink(generated / "copy.schema.json")
        text = self.root / "spec/0.2.0/AGENT-HOOKS-0.1.md"
        text.unlink()
        os.symlink("../0.1.0/AGENT-HOOKS-0.1.md", text)
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("AGENT-HOOKS-0.1.md is a symbolic link", str(raised.exception))

    def test_symbolic_link_directories_fail(self) -> None:
        schema = self.root / "spec/0.2.0/schema"
        generated = schema / "generated"
        shutil.rmtree(generated)
        os.symlink("../../0.1.0/schema/generated", generated)
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("generated is a symbolic link", str(raised.exception))
        os.unlink(generated)
        shutil.rmtree(schema)
        os.symlink("../0.1.0/schema", schema)
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("schema is a symbolic link", str(raised.exception))

    def test_navigation_lists_versions_newest_first_then_the_draft(self) -> None:
        stage.stage(self.root)
        staged = (self.root / "docs-site/mkdocs.staged.yml").read_text(encoding="utf-8")
        self.assertEqual(
            staged,
            """site_name: test
nav:
  - Home: index.md
  # The Specification entries are regenerated at build time.
  - Specification:
      - "0.10.0": spec/0.10.0.md
      - "0.2.0": spec/0.2.0.md
      - "0.1.1": spec/0.1.1.md
      - "0.1.0": spec/0.1.0.md
      - Draft: spec-draft.md
  - FAQ: faq.md
""",
        )

    def test_restaging_replaces_stale_output(self) -> None:
        stage.stage(self.root)
        (self.docs / "spec/9.9.9.md").write_text("stale\n", encoding="utf-8")
        (self.docs / "schema/v9.9").mkdir()
        stage.stage(self.root)
        self.assertFalse((self.docs / "spec/9.9.9.md").exists())
        self.assertFalse((self.docs / "schema/v9.9").exists())


class PublishedPathTest(unittest.TestCase):
    def test_bad_ids_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "x.schema.json"
            cases = {
                "https://example.invalid/other/x.json": "no /schema/ segment",
                ID_BASE + "v0.1/../x.json": "does not name a file under a path",
                ID_BASE + "v0.1": "does not name a file under a path",
                ID_BASE + "v0.1/x.json\n::error::injected": "control characters",
            }
            for identity, expected in cases.items():
                file.write_text(json.dumps({"$id": identity}))
                with self.assertRaises(SystemExit) as raised:
                    stage.published_path(file)
                self.assertIn(expected, str(raised.exception), identity)
                self.assertNotIn("\n", str(raised.exception))
            file.write_text(json.dumps({"title": "no id"}))
            with self.assertRaises(SystemExit):
                stage.published_path(file)

    def test_percent_and_line_breaks_are_escaped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "x.schema.json"
            file.write_text(json.dumps({"$id": "https://example.invalid/50%/x.json"}))
            with self.assertRaises(SystemExit) as raised:
                stage.published_path(file)
            self.assertIn("50%25/x.json", str(raised.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
