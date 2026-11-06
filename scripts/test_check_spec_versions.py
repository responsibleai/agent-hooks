#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/check-spec-versions.py.

Each case builds a minimal repository tree in a temporary directory: a
released 0.1 bundle in the flat schema layout, a draft in the generated
layout, a conformance tree and a docs folder for the reference scan.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-spec-versions.py")
MODULE_SPEC = importlib.util.spec_from_file_location("check_spec_versions", SCRIPT)
assert MODULE_SPEC and MODULE_SPEC.loader
versions = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(versions)

README = "| [0.1](0.1/) | row |\n| [draft](draft/) | row |\n"


def header(status: str, version: str) -> str:
    return f"# spec\n\n> **Status:** {status} · **Version:** `{version}` · **Date:** 2026-10-22\n"


ID_ORIGIN = "https://responsibleai.github.io/agent-hooks/schema/"


def bundle(root: Path, name: str, layout: str) -> Path:
    """A bundle: 'flat' puts schemas under schema/ with agent-context/,
    'generated' under schema/generated/ with strict-contexts/ and src/."""
    folder = root / "spec" / name
    schemas = folder / "schema" / ("generated" if layout == "generated" else "")
    points = schemas / ("strict-contexts" if layout == "generated" else "agent-context")
    points.mkdir(parents=True)
    if layout == "generated":
        (folder / "schema/src").mkdir()
    text = versions.expected_text(folder)
    status, version = ("Draft", "DRAFT") if name == "draft" else ("Released", name)
    (folder / text).write_text(header(status, version), encoding="utf-8")
    for relative in (
        "DECLARATION-VERSIONS.md",
        "declaration-errors.json",
        "reserved-reasons.json",
    ):
        (folder / relative).write_text(
            "{}\n" if relative.endswith(".json") else "# x\n"
        )
    base = ID_ORIGIN + ("draft/" if name == "draft" else f"v{name}/")
    # The draft pins `spec` to its own string; a release admits its own.
    spec = (
        {"type": "string", "const": "agent-hooks/draft"}
        if name == "draft"
        else {"type": "string", "pattern": "^agent-hooks/\\d+\\.\\d+$"}
    )
    (schemas / "agent-context.schema.json").write_text(
        json.dumps(
            {"$id": f"{base}agent-context.schema.json", "properties": {"spec": spec}}
        )
        + "\n",
        encoding="utf-8",
    )
    (schemas / "verdict.schema.json").write_text(
        f'{{"$id": "{base}verdict.schema.json"}}\n', encoding="utf-8"
    )
    (points / "input.schema.json").write_text(
        f'{{"$id": "{base}agent-context/input.schema.json"}}\n', encoding="utf-8"
    )
    return folder


def conformance(root: Path) -> None:
    """Versioned suites plus released golden files."""
    (root / "conformance/golden").mkdir(parents=True)
    write = lambda relative, value: (root / relative).write_text(  # noqa: E731
        json.dumps(value) + "\n", encoding="utf-8"
    )
    for version in ("draft", "0.1"):
        suite = root / "conformance" / version
        (suite / "vectors").mkdir(parents=True)
        published = "draft" if version == "draft" else f"v{version}"
        write(
            f"conformance/{version}/vectors.schema.json",
            {"$id": f"{ID_ORIGIN}{published}/conformance/vectors.schema.json"},
        )
        write(
            f"conformance/{version}/vectors/AH-CTK-001.json",
            {
                "id": "AH-CTK-001",
                "host_declaration": {"spec": f"agent-hooks/{version}"},
            },
        )
        write(
            f"conformance/{version}/vectors/AH-CTK-002.json",
            {
                "id": "AH-CTK-002",
                "host_declaration_invalid": True,
                "host_declaration": {"spec": "agent-hooks/9.0"},
            },
        )
    write(
        "conformance/golden/declaration.json",
        {"fixtures": [{"id": "d1", "document": {"spec": "agent-hooks/0.1"}}]},
    )
    write(
        "conformance/golden/identity.json",
        {
            "spec": "agent-hooks/0.1",
            "fixtures": [{"id": "i1", "ctx": {"spec": "agent-hooks/0.1"}}],
        },
    )


def add_suite(root: Path, version: str) -> None:
    suite = root / "conformance" / version
    (suite / "vectors").mkdir(parents=True, exist_ok=True)
    published = "draft" if version == "draft" else f"v{version}"
    (suite / "vectors.schema.json").write_text(
        json.dumps({"$id": f"{ID_ORIGIN}{published}/conformance/vectors.schema.json"}),
        encoding="utf-8",
    )
    (suite / "vectors/AH-CTK-001.json").write_text(
        json.dumps(
            {"id": "AH-CTK-001", "host_declaration": {"spec": f"agent-hooks/{version}"}}
        ),
        encoding="utf-8",
    )


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "spec").mkdir()
        (self.root / "spec/README.md").write_text(README, encoding="utf-8")
        bundle(self.root, "0.1", "flat")
        bundle(self.root, "draft", "generated")
        conformance(self.root)
        (self.root / "docs").mkdir()
        (self.root / "docs/guide.md").write_text(
            "See [the spec](../spec/0.1/AGENT-HOOKS-0.1.md) and the draft "
            "spec/draft/AGENT-HOOKS-DRAFT.md.\n",
            encoding="utf-8",
        )

    def test_complete_tree_passes(self) -> None:
        self.assertEqual(versions.check(self.root), [])
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), str(self.root)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "specification folders agree: 0.1, draft\n")

    def test_header_must_match_the_folder(self) -> None:
        text = self.root / "spec/0.1/AGENT-HOOKS-0.1.md"
        text.write_text(header("Released", "0.1.0"), encoding="utf-8")
        self.assertIn(
            "spec/0.1/AGENT-HOOKS-0.1.md header says Version 0.1.0; expected 0.1",
            versions.check(self.root),
        )
        text.write_text(header("Beta", "0.1"), encoding="utf-8")
        self.assertIn(
            "spec/0.1/AGENT-HOOKS-0.1.md header says Status Beta; expected Released",
            versions.check(self.root),
        )
        text.write_text("# spec without a header line\n", encoding="utf-8")
        self.assertTrue(
            any("has no '> **Status:**" in e for e in versions.check(self.root))
        )

    def test_draft_header_says_draft(self) -> None:
        text = self.root / "spec/draft/AGENT-HOOKS-DRAFT.md"
        text.write_text(header("Released", "0.2"), encoding="utf-8")
        errors = versions.check(self.root)
        self.assertIn(
            "spec/draft/AGENT-HOOKS-DRAFT.md header says Status Released; expected Draft",
            errors,
        )
        self.assertIn(
            "spec/draft/AGENT-HOOKS-DRAFT.md header says Version 0.2; expected DRAFT",
            errors,
        )

    def test_text_file_name_must_match(self) -> None:
        (self.root / "spec/0.1/AGENT-HOOKS-0.1.md").rename(
            self.root / "spec/0.1/AGENT-HOOKS-0.1.0.md"
        )
        errors = versions.check(self.root)
        self.assertTrue(
            any(
                e.startswith(
                    "spec/0.1 must contain exactly one specification text, AGENT-HOOKS-0.1.md"
                )
                for e in errors
            ),
            errors,
        )

    def test_patch_level_folder_is_rejected(self) -> None:
        bundle(self.root, "0.1.0", "flat")
        self.assertIn(
            "spec/0.1.0/ is not draft or a MAJOR.MINOR version",
            versions.check(self.root),
        )

    def test_any_schema_layout_passes_and_an_empty_schema_folder_fails(self) -> None:
        bundle(self.root, "0.2", "generated")
        add_suite(self.root, "0.2")
        (self.root / "spec/README.md").write_text(
            README + "| [0.2](0.2/) | row |\n", encoding="utf-8"
        )
        self.assertEqual(versions.check(self.root), [])
        # No file name is fixed: a bundle may rename or drop a root schema.
        (self.root / "spec/0.2/schema/generated/agent-context.schema.json").unlink()
        (self.root / "spec/0.2/schema/generated/context.schema.json").write_text(
            f'{{"$id": "{ID_ORIGIN}v0.2/context.schema.json"}}\n', encoding="utf-8"
        )
        self.assertEqual(versions.check(self.root), [])
        for file in (self.root / "spec/0.2/schema/generated").rglob("*.schema.json"):
            file.unlink()
        # Source and example files are not schemas.
        (self.root / "spec/0.2/schema/src/verdict.ts").write_text("export {};\n")
        (self.root / "spec/0.2/schema/examples/Verdict").mkdir(parents=True)
        (self.root / "spec/0.2/schema/examples/Verdict/x.schema.json").write_text(
            "{}\n"
        )
        errors = versions.check(self.root)
        self.assertIn(
            "spec/0.2/schema has no *.schema.json files outside src/ and examples/",
            errors,
        )

    @unittest.skipIf(os.name == "nt", "symlink creation may require Windows elevation")
    def test_symlinked_file_fails(self) -> None:
        link = self.root / "spec/0.1/schema/extra.schema.json"
        os.symlink("verdict.schema.json", link)
        self.assertIn(
            "spec/0.1/schema/extra.schema.json is a symbolic link; "
            "specification folders hold regular files only",
            versions.check(self.root),
        )

    @unittest.skipIf(os.name == "nt", "symlink creation may require Windows elevation")
    def test_symlinked_version_folder_fails_and_is_not_a_bundle(self) -> None:
        os.symlink("draft", self.root / "spec/0.2")
        errors = versions.check(self.root)
        self.assertTrue(
            any(e.startswith("spec/0.2 is a symbolic link") for e in errors)
        )
        self.assertFalse(any("does not link spec/0.2" in e for e in errors))

    def test_hidden_files_fail(self) -> None:
        (self.root / "spec/0.1/schema/.gitattributes").write_text("* text\n")
        (self.root / "spec/.gitignore").write_text("build/\n")
        errors = versions.check(self.root)
        self.assertIn(
            "spec/0.1/schema/.gitattributes starts with a dot; specification folders hold no hidden files",
            errors,
        )
        self.assertIn(
            "spec/.gitignore starts with a dot; specification folders hold no hidden files",
            errors,
        )
        self.assertFalse(any("must live in a version folder" in e for e in errors))

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes need a POSIX file system")
    def test_non_regular_entry_fails(self) -> None:
        os.mkfifo(self.root / "spec/draft/pipe.json")
        self.assertIn(
            "spec/draft/pipe.json is not a regular file or directory",
            versions.check(self.root),
        )

    @unittest.skipIf(os.name == "nt", "symlink creation may require Windows elevation")
    def test_spec_itself_as_a_symlink_fails(self) -> None:
        (self.root / "spec").rename(self.root / "elsewhere")
        os.symlink("elsewhere", self.root / "spec")
        self.assertEqual(
            versions.check(self.root),
            ["spec is a symbolic link; specification folders hold regular files only"],
        )

    def test_non_ascii_digit_folder_is_not_a_version(self) -> None:
        bundle(self.root, "0.Ù¡", "flat")
        self.assertIn(
            "spec/0.Ù¡/ is not draft or a MAJOR.MINOR version",
            versions.check(self.root),
        )

    def test_invalid_json_is_reported(self) -> None:
        (self.root / "spec/draft/reserved-reasons.json").write_text(
            "{", encoding="utf-8"
        )
        errors = versions.check(self.root)
        self.assertTrue(
            any(
                e.startswith("spec/draft/reserved-reasons.json is invalid JSON")
                for e in errors
            )
        )

    def test_ids_must_sit_under_the_bundle_path(self) -> None:
        (self.root / "spec/0.1/reserved-reasons.json").write_text(
            f'{{"$id": "{ID_ORIGIN}draft/reserved-reasons.json"}}\n', encoding="utf-8"
        )
        (self.root / "spec/draft/schema/generated/verdict.schema.json").write_text(
            f'{{"$id": "{ID_ORIGIN}v0.1/verdict.schema.json"}}\n', encoding="utf-8"
        )
        errors = versions.check(self.root)
        self.assertIn(
            f"spec/0.1/reserved-reasons.json has $id {ID_ORIGIN}draft/reserved-reasons.json; "
            f"expected one under {ID_ORIGIN}v0.1/",
            errors,
        )
        self.assertIn(
            f"spec/draft/schema/generated/verdict.schema.json has $id "
            f"{ID_ORIGIN}v0.1/verdict.schema.json; expected one under {ID_ORIGIN}draft/",
            errors,
        )

    def test_a_bundle_carries_its_own_wire_string_only(self) -> None:
        (self.root / "spec/0.1/AGENT-HOOKS-0.1.md").write_text(
            header("Released", "0.1")
            + "Contexts carry `agent-hooks/0.1`; see also `agent-hooks/0.2` "
            "and `agent-hooks/draft`.\n",
            encoding="utf-8",
        )
        (self.root / "spec/draft/AGENT-HOOKS-DRAFT.md").write_text(
            header("Draft", "DRAFT")
            + "The draft carries `agent-hooks/draft`, never `agent-hooks/0.1`.\n",
            encoding="utf-8",
        )
        self.assertEqual(
            versions.check(self.root),
            [
                "spec/0.1/AGENT-HOOKS-0.1.md carries the wire string of another version "
                "(agent-hooks/0.2, agent-hooks/draft); spec/0.1/ carries agent-hooks/0.1 only",
                "spec/draft/AGENT-HOOKS-DRAFT.md carries the wire string of another version "
                "(agent-hooks/0.1); spec/draft/ carries agent-hooks/draft only",
            ],
        )

    def test_spec_member_schemas_name_the_bundles_own_wire_string(self) -> None:
        # The draft pins the member to a constant; a pattern is not enough.
        draft = self.root / "spec/draft/schema/generated/agent-context.schema.json"
        draft.write_text(
            json.dumps(
                {
                    "$id": f"{ID_ORIGIN}draft/agent-context.schema.json",
                    "$defs": {
                        "InputContext": {
                            "properties": {
                                "spec": {"type": "string", "pattern": "^agent-hooks/"}
                            }
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        # A release admits its own string by const, enum or pattern.
        release = self.root / "spec/0.1/schema/agent-context.schema.json"
        release.write_text(
            json.dumps(
                {
                    "$id": f"{ID_ORIGIN}v0.1/agent-context.schema.json",
                    "properties": {
                        "spec": {"type": "string", "const": "agent-hooks/0.2"}
                    },
                }
            ),
            encoding="utf-8",
        )
        errors = versions.check(self.root)
        self.assertIn(
            "spec/draft/schema/generated/agent-context.schema.json "
            "$.$defs.InputContext.properties.spec does not pin spec to the constant "
            "agent-hooks/draft; a draft instance carries that string only",
            errors,
        )
        self.assertIn(
            "spec/0.1/schema/agent-context.schema.json $.properties.spec does not "
            "admit agent-hooks/0.1, the bundle's own wire string",
            errors,
        )
        self.assertIn(
            "spec/0.1/schema/agent-context.schema.json carries the wire string of "
            "another version (agent-hooks/0.2); spec/0.1/ carries agent-hooks/0.1 only",
            errors,
        )
        self.assertEqual(len(errors), 3, errors)
        for admitted in (
            {"enum": ["agent-hooks/0.1", "agent-hooks/0.2"]},
            {"pattern": "^agent-hooks/0\\.1$"},
            {"type": "string"},
        ):
            self.assertTrue(versions.admits(admitted, "agent-hooks/0.1"), admitted)
        self.assertFalse(
            versions.admits({"const": "agent-hooks/draft"}, "agent-hooks/0.1")
        )
        self.assertFalse(versions.admits({"pattern": "("}, "agent-hooks/0.1"))

    def test_each_conformance_suite_is_bound_to_its_spec_version(self) -> None:
        self.assertEqual(versions.check(self.root), [])
        (self.root / "conformance/draft/vectors/AH-CTK-001.json").write_text(
            json.dumps(
                {"id": "AH-CTK-001", "host_declaration": {"spec": "agent-hooks/0.1"}}
            ),
            encoding="utf-8",
        )
        (self.root / "conformance/0.1/vectors.schema.json").write_text(
            json.dumps(
                {
                    "$id": f"{ID_ORIGIN}v0.1/conformance/vectors.schema.json",
                    "$ref": f"{ID_ORIGIN}draft/verdict.schema.json",
                }
            ),
            encoding="utf-8",
        )
        identity = json.loads(
            (self.root / "conformance/golden/identity.json").read_text(encoding="utf-8")
        )
        identity["fixtures"][0]["ctx"]["spec"] = "agent-hooks/draft"
        (self.root / "conformance/golden/identity.json").write_text(
            json.dumps(identity), encoding="utf-8"
        )
        (self.root / "conformance/golden/declaration.json").write_text(
            json.dumps({"fixtures": [{"id": "d1", "document": {}}]}), encoding="utf-8"
        )
        errors = versions.check(self.root)
        self.assertIn(
            "conformance/draft/vectors/AH-CTK-001.json: host_declaration.spec is "
            "'agent-hooks/0.1'; the suite requires agent-hooks/draft",
            errors,
        )
        self.assertIn(
            "conformance/0.1/vectors.schema.json has cross-version $ref "
            f"{ID_ORIGIN}draft/verdict.schema.json",
            next(error for error in errors if "has cross-version $ref" in error),
        )
        self.assertTrue(
            any("conformance/golden/declaration.json:" in error for error in errors)
        )
        self.assertTrue(
            any("conformance/golden/identity.json:" in error for error in errors)
        )
        (self.root / "conformance/golden/identity.json").unlink()
        self.assertIn(
            "conformance/golden/identity.json is missing", versions.check(self.root)
        )
        shutil.rmtree(self.root / "conformance/draft/vectors")
        self.assertIn(
            "conformance/draft/vectors/ is missing", versions.check(self.root)
        )

    def test_empty_versioned_suite_fails(self) -> None:
        for path in (self.root / "conformance/0.1/vectors").glob("*.json"):
            path.unlink()
        self.assertIn("conformance/0.1/vectors/ is empty", versions.check(self.root))

    def test_stale_references_fail(self) -> None:
        (self.root / "docs/old.md").write_text(
            "Read spec/0.1.0/AGENT-HOOKS-0.1.md, then spec/draft/AGENT-HOOKS-0.1.md,\n"
            "then AGENT-HOOKS-0.2.md, and never spec/draft/AGENT-HOOKS-DRAFT.md.\n",
            encoding="utf-8",
        )
        errors = versions.check(self.root)
        self.assertIn(
            "docs/old.md:1 names a spec/<MAJOR.MINOR.PATCH> path; "
            "specification folders are spec/<MAJOR.MINOR>/",
            errors,
        )
        self.assertIn(
            "docs/old.md:1 links spec/draft/AGENT-HOOKS-0.1.md, which does not exist",
            errors,
        )
        self.assertIn(
            "docs/old.md:2 names AGENT-HOOKS-0.2.md, but spec/0.2/ does not hold it",
            errors,
        )
        self.assertFalse(any("AGENT-HOOKS-DRAFT.md" in e for e in errors))

    def test_placeholders_are_not_references_and_patch_names_are(self) -> None:
        (self.root / "docs/how.md").write_text(
            "Cut `spec/<X.Y>/AGENT-HOOKS-<X.Y>.md`, never AGENT-HOOKS-A.B.md, "
            "and not AGENT-HOOKS-0.1.0.md either.\n",
            encoding="utf-8",
        )
        errors = versions.check(self.root)
        self.assertEqual(
            errors,
            [
                "docs/how.md:1 names AGENT-HOOKS-0.1.0.md, but spec/0.1.0/ does not hold it"
            ],
        )

    def test_script_tests_are_not_scanned(self) -> None:
        (self.root / "scripts").mkdir()
        (self.root / "scripts/test_fixture.py").write_text(
            'OLD = "spec/0.1.0/AGENT-HOOKS-0.1.md"\n'
        )
        (self.root / "scripts/helper.py").write_text(
            'OLD = "spec/0.1.0/AGENT-HOOKS-0.1.md"\n'
        )
        errors = versions.check(self.root)
        self.assertEqual(len(errors), 2, errors)
        self.assertTrue(
            all(e.startswith("scripts/helper.py:1") for e in errors), errors
        )

    def test_proposals_are_not_scanned(self) -> None:
        (self.root / "docs/proposals").mkdir()
        (self.root / "docs/proposals/P-001-x.md").write_text(
            "spec/0.1.0/AGENT-HOOKS-0.1.md\n"
        )
        self.assertEqual(versions.check(self.root), [])

    def test_frozen_folders_and_build_output_are_not_scanned(self) -> None:
        (self.root / "spec/0.1/notes.md").write_text("spec/0.1.0 was the old name\n")
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules/x.md").write_text("spec/0.1.0\n")
        self.assertEqual(versions.check(self.root), [])

    def test_annotation_encodes_the_message(self) -> None:
        self.assertEqual(
            versions.escape_data("50%\r\n::error::x"), "50%25%0D%0A::error::x"
        )


class VersionPatternTest(unittest.TestCase):
    def test_major_minor_with_ascii_digits_only(self) -> None:
        self.assertTrue(versions.VERSION.fullmatch("0.1"))
        self.assertTrue(versions.VERSION.fullmatch("10.22"))
        self.assertIsNone(versions.VERSION.fullmatch("0.1.0"))
        self.assertIsNone(versions.VERSION.fullmatch("0.Ù¡"))
        self.assertIsNone(versions.VERSION.fullmatch("01.1"))
        self.assertIsNone(versions.VERSION.fullmatch("0.1-beta"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
