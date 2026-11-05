#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/stage-docs-site.py.

Each case stages a small repository tree built in a temporary
directory: released bundles in both schema layouts and a draft.
"""

import importlib.util
import json
import os
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
      - "0.0": spec/0.0.md
      - Draft: spec/draft.md
  - FAQ: faq.md
"""


def schema(identity: str, marker: str) -> str:
    return json.dumps({"$id": ID_BASE + identity, "title": marker}) + "\n"


def bundle(
    root: Path,
    name: str,
    wire: str,
    marker: str,
    layout: str = "generated",
    inventories: tuple[str, ...] = stage.INVENTORIES,
) -> Path:
    """A bundle whose schemas publish under <wire> and carry <marker>.
    'generated' puts them under schema/generated/ with strict-contexts/
    and a src/ folder; 'flat' puts them under schema/ with agent-context/."""
    folder = root / "spec" / name
    schemas = folder / "schema" / ("generated" if layout == "generated" else "")
    points = schemas / ("strict-contexts" if layout == "generated" else "agent-context")
    points.mkdir(parents=True)
    if layout == "generated":
        (folder / "schema/src").mkdir()
        (folder / "schema/src/verdict.ts").write_text("export {};\n", encoding="utf-8")
    text = "AGENT-HOOKS-DRAFT.md" if name == "draft" else f"AGENT-HOOKS-{name}.md"
    (folder / text).write_text(f"# spec {name}\n", encoding="utf-8")
    for inventory in inventories:
        (folder / inventory).write_text(
            json.dumps({"$id": ID_BASE + f"{wire}/{inventory}", "from": name}),
            encoding="utf-8",
        )
    (schemas / "agent-context.schema.json").write_text(
        schema(f"{wire}/agent-context.schema.json", marker), encoding="utf-8"
    )
    (points / "input.schema.json").write_text(
        schema(f"{wire}/agent-context/input.schema.json", marker), encoding="utf-8"
    )
    return folder


class StageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        # 0.1 is flat and predates reserved-warnings.json, like the real one.
        bundle(
            self.root,
            "0.1",
            "v0.1",
            "first",
            layout="flat",
            inventories=("reserved-reasons.json", "declaration-errors.json"),
        )
        bundle(self.root, "0.2", "v0.2", "second")
        # 0.10 sorts after 0.2 numerically, not lexically.
        bundle(self.root, "0.10", "v0.10", "tenth")
        draft = bundle(self.root, "draft", "draft", "working")
        (draft / "AGENT-HOOKS-DRAFT.md").write_text(
            "> The latest released version is [0.10](../0.10/AGENT-HOOKS-0.10.md).\n# draft\n",
            encoding="utf-8",
        )
        for version, published in (
            ("0.1", "v0.1"),
            ("0.2", "v0.2"),
            ("0.10", "v0.10"),
            ("draft", "draft"),
        ):
            suite = self.root / "conformance" / version
            suite.mkdir(parents=True)
            (suite / "vectors.schema.json").write_text(
                schema(f"{published}/conformance/vectors.schema.json", version),
                encoding="utf-8",
            )
        (self.root / "docs-site/docs").mkdir(parents=True)
        (self.root / "docs-site/mkdocs.yml").write_text(MKDOCS, encoding="utf-8")
        self.docs = self.root / "docs-site/docs"

    def read(self, relative: str) -> str:
        return (self.docs / relative).read_text(encoding="utf-8")

    def test_versions_are_ordered_numerically_newest_first(self) -> None:
        self.assertEqual(stage.stage(self.root), ["0.10", "0.2", "0.1"])

    def test_one_page_per_version_the_draft_page_and_the_latest_alias(self) -> None:
        for version in stage.stage(self.root):
            self.assertEqual(self.read(f"spec/{version}.md"), f"# spec {version}\n")
        self.assertEqual(self.read("spec.md"), "# spec 0.10\n")
        self.assertEqual(
            self.read("spec/draft.md"),
            "> The latest released version is [0.10](0.10.md).\n# draft\n",
        )
        self.assertFalse((self.docs / "spec-draft.md").exists())

    def test_text_file_must_carry_the_folder_name(self) -> None:
        (self.root / "spec/0.2/AGENT-HOOKS-0.2.md").rename(
            self.root / "spec/0.2/AGENT-HOOKS-0.2.0.md"
        )
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn(
            "exactly one specification text, AGENT-HOOKS-0.2.md", str(raised.exception)
        )

    def test_schemas_from_any_layout_land_at_their_id_paths(self) -> None:
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
        self.assertEqual(
            json.loads(self.read("schema/draft/agent-context.schema.json"))["title"],
            "working",
        )
        self.assertEqual(
            json.loads(self.read("schema/draft/agent-context/input.schema.json"))[
                "title"
            ],
            "working",
        )
        for version in ("v0.1", "v0.2", "v0.10", "draft"):
            self.assertEqual(
                json.loads(
                    self.read(f"schema/{version}/conformance/vectors.schema.json")
                )["title"],
                "0.1" if version == "v0.1" else version.removeprefix("v"),
            )
        self.assertFalse((self.docs / "schema/strict-contexts").exists())
        self.assertFalse((self.docs / "schema/v0.2/src").exists())

    def test_inventories_follow_the_bundle_and_absent_ones_are_not_published(
        self,
    ) -> None:
        stage.stage(self.root)
        for name in ("reserved-reasons.json", "declaration-errors.json"):
            self.assertEqual(
                json.loads(self.read(f"schema/v0.1/{name}"))["from"], "0.1"
            )
        self.assertFalse((self.docs / "schema/v0.1/reserved-warnings.json").exists())
        for name in stage.INVENTORIES:
            self.assertEqual(
                json.loads(self.read(f"schema/v0.10/{name}"))["from"], "0.10"
            )
            self.assertEqual(
                json.loads(self.read(f"schema/draft/{name}"))["from"], "draft"
            )

    def test_a_shared_path_with_identical_bytes_is_allowed(self) -> None:
        bundle(self.root, "0.3", "v0.2", "second")
        suite = self.root / "conformance/0.3"
        suite.mkdir(parents=True)
        (suite / "vectors.schema.json").write_text(
            schema("v0.2/conformance/vectors.schema.json", "0.2"),
            encoding="utf-8",
        )
        for inventory in stage.INVENTORIES:
            (self.root / "spec/0.3" / inventory).write_text(
                json.dumps({"$id": ID_BASE + f"v0.2/{inventory}", "from": "0.2"})
            )
        self.assertEqual(stage.stage(self.root), ["0.10", "0.3", "0.2", "0.1"])

    def test_an_inventory_whose_id_names_another_path_fails(self) -> None:
        (self.root / "spec/0.2/reserved-reasons.json").write_text(
            json.dumps({"$id": ID_BASE + "draft/reserved-reasons.json"})
        )
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn(
            "spec/0.2/reserved-reasons.json: $id names schema/draft/reserved-reasons.json; "
            "the bundle publishes under schema/v0.2/",
            str(raised.exception),
        )

    def test_a_shared_path_with_different_bytes_fails(self) -> None:
        bundle(self.root, "0.3", "v0.2", "changed")
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        message = str(raised.exception)
        self.assertIn(
            "spec/0.3 and spec/0.2 both publish schema/v0.2/agent-context.schema.json",
            message,
        )
        self.assertIn("ID_BASE", message)

    @unittest.skipIf(os.name == "nt", "symlink creation may require Windows elevation")
    def test_symbolic_links_fail(self) -> None:
        generated = self.root / "spec/0.2/schema/generated"
        os.symlink("agent-context.schema.json", generated / "copy.schema.json")
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("copy.schema.json is a symbolic link", str(raised.exception))
        os.unlink(generated / "copy.schema.json")
        text = self.root / "spec/0.2/AGENT-HOOKS-0.2.md"
        text.unlink()
        os.symlink("../0.1/AGENT-HOOKS-0.1.md", text)
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("AGENT-HOOKS-0.2.md", str(raised.exception))

    @unittest.skipIf(os.name == "nt", "symlink creation may require Windows elevation")
    def test_symlinked_schema_directories_fail(self) -> None:
        generated = self.root / "spec/0.2/schema/generated"
        import shutil

        shutil.rmtree(generated)
        os.symlink("../../0.10/schema/generated", generated)
        with self.assertRaises(SystemExit) as raised:
            stage.stage(self.root)
        self.assertIn("generated is a symbolic link", str(raised.exception))
        os.unlink(generated)
        schema_dir = self.root / "spec/0.2/schema"
        shutil.rmtree(schema_dir)
        os.symlink("../0.10/schema", schema_dir)
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
      - "0.10": spec/0.10.md
      - "0.2": spec/0.2.md
      - "0.1": spec/0.1.md
      - Draft: spec/draft.md
  - FAQ: faq.md
""",
        )

    def test_restaging_replaces_stale_output(self) -> None:
        stage.stage(self.root)
        (self.docs / "spec/9.9.md").write_text("stale\n", encoding="utf-8")
        (self.docs / "schema/v9.9").mkdir()
        stage.stage(self.root)
        self.assertFalse((self.docs / "spec/9.9.md").exists())
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
