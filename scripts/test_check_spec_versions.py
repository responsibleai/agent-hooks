#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/check-spec-versions.py.

Each case builds a minimal spec/ tree in a temporary directory, so the
checks run against a known layout rather than the checkout.
"""

import importlib.util
import os
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

README = "| [0.1.0](0.1.0/) | row |\n| [draft](draft/) | row |\n"


def bundle(root: Path, name: str) -> None:
    folder = root / "spec" / name
    (folder / "schema/src").mkdir(parents=True)
    (folder / "schema/generated/strict-contexts").mkdir(parents=True)
    (folder / "AGENT-HOOKS-0.1.md").write_text("# spec\n", encoding="utf-8")
    for relative in versions.REQUIRED_FILES:
        (folder / relative).write_text(
            "{}\n" if relative.endswith(".json") else "# x\n"
        )


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "spec").mkdir()
        (self.root / "spec/README.md").write_text(README, encoding="utf-8")
        bundle(self.root, "0.1.0")
        bundle(self.root, "draft")

    def test_complete_tree_passes(self) -> None:
        self.assertEqual(versions.check(self.root), [])
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), str(self.root)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "specification folders agree: 0.1.0, draft\n")

    def test_symlinked_file_fails(self) -> None:
        link = self.root / "spec/0.1.0/schema/generated/extra.schema.json"
        os.symlink("verdict.schema.json", link)
        errors = versions.check(self.root)
        self.assertEqual(
            errors,
            [
                "spec/0.1.0/schema/generated/extra.schema.json is a symbolic link; "
                "specification folders hold regular files only"
            ],
        )

    def test_symlinked_version_folder_fails_and_is_not_a_bundle(self) -> None:
        os.symlink("draft", self.root / "spec/0.2.0")
        errors = versions.check(self.root)
        self.assertTrue(
            any(e.startswith("spec/0.2.0 is a symbolic link") for e in errors)
        )
        self.assertFalse(any("does not link spec/0.2.0" in e for e in errors))

    def test_non_ascii_digit_folder_is_not_a_version(self) -> None:
        bundle(self.root, "0.1١.0")
        errors = versions.check(self.root)
        self.assertIn(
            "spec/0.1١.0/ is not draft or a MAJOR.MINOR.PATCH version", errors
        )

    def test_missing_file_and_invalid_json_are_reported(self) -> None:
        (self.root / "spec/draft/reserved-reasons.json").write_text(
            "{", encoding="utf-8"
        )
        (self.root / "spec/0.1.0/declaration-errors.json").unlink()
        errors = versions.check(self.root)
        self.assertIn("spec/0.1.0/declaration-errors.json is missing", errors)
        self.assertTrue(
            any(
                e.startswith("spec/draft/reserved-reasons.json is invalid JSON")
                for e in errors
            )
        )

    def test_annotation_encodes_the_message(self) -> None:
        self.assertEqual(
            versions.escape_data("50%\r\n::error::x"), "50%25%0D%0A::error::x"
        )


class VersionPatternTest(unittest.TestCase):
    def test_ascii_digits_only(self) -> None:
        self.assertTrue(versions.VERSION.fullmatch("0.1.0"))
        self.assertTrue(versions.VERSION.fullmatch("10.22.303"))
        self.assertIsNone(versions.VERSION.fullmatch("0.1١.0"))
        self.assertIsNone(versions.VERSION.fullmatch("01.1.0"))
        self.assertIsNone(versions.VERSION.fullmatch("0.1.0-beta"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
