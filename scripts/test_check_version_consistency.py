#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/check-version-consistency.py."""

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_version_consistency",
    Path(__file__).with_name("check-version-consistency.py"),
)
assert MODULE_SPEC and MODULE_SPEC.loader
check_version_consistency = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(check_version_consistency)


class PlatformPinTest(unittest.TestCase):
    def run_check(self, package):
        with tempfile.TemporaryDirectory() as temporary:
            package_path = Path(temporary) / "package.json"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                result = check_version_consistency.check_no_committed_platform_pins(
                    package_path
                )
            return result, output.getvalue()

    def test_absent_optional_dependencies_pass(self):
        result, output = self.run_check({"name": "agent-hooks"})

        self.assertEqual(result, 0)
        self.assertEqual(output, "")

    def test_committed_optional_dependencies_fail(self):
        result, output = self.run_check(
            {"name": "agent-hooks", "optionalDependencies": {"platform": "1.0.0"}}
        )

        self.assertEqual(result, 1)
        self.assertEqual(
            output,
            "sdk/typescript/package.json commits optionalDependencies; "
            "platform pins are injected at publish time (see release.yml)\n",
        )

    def test_main_enforces_platform_pin_check(self):
        with (
            patch.object(
                check_version_consistency,
                "check_no_committed_platform_pins",
                return_value=1,
            ) as check,
            patch.object(
                check_version_consistency, "check_declaration_versions"
            ) as declarations,
        ):
            self.assertEqual(check_version_consistency.main(), 1)

        check.assert_called_once_with()
        declarations.assert_not_called()


CURRENT = "agent-hooks-declaration/1.1"
TYPES_RS = (
    'pub const DECLARATION_VERSION: &str = "agent-hooks-declaration/1.1";\n'
    "pub const SUPPORTED_DECLARATION_VERSIONS: &[&str] = "
    '&["agent-hooks-declaration/1.0", DECLARATION_VERSION];\n'
)
CONTRACT_ROW = f"| `{CURRENT}` | current | schema | 0.1.0-beta | |\n"
RELEASE_ROW = (
    f"| `v0.1.0-beta.4` | `agent-hooks-declaration/1.0`, `{CURRENT}` | `{CURRENT}` |\n"
)


class DeclarationTablesTest(unittest.TestCase):
    """The current row is read from the development bundle and the
    release row from VERSIONING.md, each from its own file."""

    def build(self, contract: str, release: str, schema: bool = True) -> Path:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        types = root / "sdk/rust/core/src/types.rs"
        types.parent.mkdir(parents=True)
        types.write_text(TYPES_RS, encoding="utf-8")
        (root / "spec/draft").mkdir(parents=True)
        (root / "spec/draft/DECLARATION-VERSIONS.md").write_text(
            "# contract versions\n" + contract, encoding="utf-8"
        )
        (root / "VERSIONING.md").write_text(
            "# versioning\n" + release, encoding="utf-8"
        )
        if schema:
            generated = root / "spec/draft/schema/generated"
            generated.mkdir(parents=True)
            (generated / "host-declaration-1.1.schema.json").write_text("{}\n")
        return root

    def run_check(self, root: Path):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = check_version_consistency.check_declaration_versions(root)
        return result, output.getvalue()

    def test_both_rows_in_their_files_pass(self):
        result, output = self.run_check(self.build(CONTRACT_ROW, RELEASE_ROW))
        self.assertEqual(result, 0, output)
        self.assertIn("declaration contract version agrees", output)

    def test_missing_current_row_fails(self):
        result, output = self.run_check(self.build("", RELEASE_ROW))
        self.assertEqual(result, 1)
        self.assertIn("spec/draft/DECLARATION-VERSIONS.md has no current row", output)

    def test_missing_release_row_fails(self):
        result, output = self.run_check(self.build(CONTRACT_ROW, ""))
        self.assertEqual(result, 1)
        self.assertIn("VERSIONING.md has no SDK release row accepting", output)

    def test_rows_in_the_wrong_files_fail(self):
        # Each row sits in the other file: neither check may pass.
        result, output = self.run_check(self.build(RELEASE_ROW, CONTRACT_ROW))
        self.assertEqual(result, 1)
        self.assertIn("spec/draft/DECLARATION-VERSIONS.md has no current row", output)
        result, output = self.run_check(self.build(CONTRACT_ROW, CONTRACT_ROW))
        self.assertEqual(result, 1)
        self.assertIn("VERSIONING.md has no SDK release row accepting", output)

    def test_missing_schema_fails(self):
        result, output = self.run_check(
            self.build(CONTRACT_ROW, RELEASE_ROW, schema=False)
        )
        self.assertEqual(result, 1)
        self.assertIn("host-declaration-1.1.schema.json is missing", output)

    def test_other_development_bundle(self):
        root = self.build(CONTRACT_ROW, RELEASE_ROW)
        shutil.move(root / "spec/draft", root / "spec/0.2")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = check_version_consistency.check_declaration_versions(
                root, "spec/0.2"
            )
        self.assertEqual(result, 0, output.getvalue())


RUST_TYPES = (
    'pub const SPEC_VERSION: &str = "agent-hooks/{spec}";\n'
    "pub const SUPPORTED_SPEC_VERSIONS: &[&str] = &[{supported}];\n"
)
TS_INDEX = (
    'export const SPEC_VERSION = "agent-hooks/{spec}";\n'
    "export const SUPPORTED_SPEC_VERSIONS: readonly string[] = Object.freeze([{supported}]);\n"
)
PY_TYPES = (
    'SPEC_VERSION: Final[str] = "agent-hooks/{spec}"\n'
    "SUPPORTED_SPEC_VERSIONS: Final[tuple[str, ...]] = ({supported},)\n"
)
CS_TYPES = (
    "public static class Spec\n{{\n"
    '    public const string Version = "agent-hooks/{spec}";\n'
    "    public static readonly IReadOnlyList<string> SupportedVersions = [{supported}];\n}}\n"
    'public static class Declaration\n{{\n    public const string Version = "agent-hooks-declaration/1.1";\n}}\n'
)
GO_TYPES = (
    'const SpecVersion = "agent-hooks/{spec}"\n'
    "var SupportedSpecVersions = []string{{{supported}}}\n"
)
CORES = {
    "sdk/rust/core/src/types.rs": RUST_TYPES,
    "sdk/typescript/src/index.ts": TS_INDEX,
    "sdk/python/python/agent_hooks/_types.py": PY_TYPES,
    "sdk/dotnet/src/AgentHooks/Types.cs": CS_TYPES,
    "sdk/go/agenthooks/types.go": GO_TYPES,
}


class SpecVersionsTest(unittest.TestCase):
    """The five cores name the same supported specification versions,
    each with a folder, SPEC_VERSION the highest, and the VERSIONING.md
    row for the SDK version agrees."""

    def build(
        self,
        spec="0.1",
        supported=("0.1",),
        folders=("0.1",),
        row="`0.1`",
        overrides=None,
    ):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        quoted = ", ".join(f'"{v}"' for v in supported)
        for path, template in CORES.items():
            text = (overrides or {}).get(path) or template.format(
                spec=spec, supported=quoted
            )
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text(text, encoding="utf-8")
        for folder in folders:
            (root / "spec" / folder).mkdir(parents=True)
        (root / "VERSIONING.md").write_text(
            "| SDK release | Spec | Accepts | Current |\n| --- | --- | --- | --- |\n"
            f"| `v0.1.0-beta.4` | {row} | `agent-hooks-declaration/1.1` | `agent-hooks-declaration/1.1` |\n",
            encoding="utf-8",
        )
        return root

    def run_check(self, root):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = check_version_consistency.check_spec_versions(root, "0.1.0-beta.4")
        return result, output.getvalue()

    def test_agreeing_cores_pass(self):
        result, output = self.run_check(self.build())
        self.assertEqual(result, 0, output)
        self.assertIn(
            "specification versions agree: agent-hooks/0.1, supported 0.1", output
        )

    def test_two_supported_versions_pass_when_spec_version_is_the_highest(self):
        root = self.build(
            spec="0.2",
            supported=("0.1", "0.2"),
            folders=("0.1", "0.2"),
            row="`0.1`, `0.2`",
        )
        self.assertEqual(self.run_check(root)[0], 0)

    def test_disagreeing_core_fails(self):
        overrides = {
            "sdk/go/agenthooks/types.go": GO_TYPES.format(
                spec="0.1", supported='"0.1", "0.2"'
            )
        }
        result, output = self.run_check(self.build(overrides=overrides))
        self.assertEqual(result, 1)
        self.assertIn("the SDKs disagree", output)
        self.assertIn("sdk/go/agenthooks/types.go", output)

    def test_draft_and_missing_folder_fail(self):
        result, output = self.run_check(
            self.build(supported=("0.1", "DRAFT"), row="`0.1`, `DRAFT`")
        )
        self.assertEqual(result, 1)
        self.assertIn("names DRAFT, not a MAJOR.MINOR version", output)
        result, output = self.run_check(
            self.build(spec="0.2", supported=("0.1", "0.2"), row="`0.1`, `0.2`")
        )
        self.assertEqual(result, 1)
        self.assertIn("spec/0.2/ does not exist", output)

    def test_spec_version_must_be_the_highest_supported(self):
        root = self.build(
            spec="0.1",
            supported=("0.1", "0.2"),
            folders=("0.1", "0.2"),
            row="`0.1`, `0.2`",
        )
        result, output = self.run_check(root)
        self.assertEqual(result, 1)
        self.assertIn("must be agent-hooks/0.2", output)

    def test_versioning_row_must_match(self):
        result, output = self.run_check(self.build(row="`0.1`, `0.2`"))
        self.assertEqual(result, 1)
        self.assertIn(
            "VERSIONING.md row for v0.1.0-beta.4 lists specification versions", output
        )
        root = self.build()
        (root / "VERSIONING.md").write_text("| none |\n", encoding="utf-8")
        result, output = self.run_check(root)
        self.assertEqual(result, 1)
        self.assertIn("has no SDK release row for v0.1.0-beta.4", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
