# Copyright (c) Microsoft. All rights reserved.

"""Exercise the Python SDK CI schema drift checks against isolated Git repositories."""

import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SCRIPT_DIR = Path(__file__).resolve().parents[1]
SCHEMA_SCRIPT = SCRIPT_DIR / "check-released-schema-mirror.sh"
DRAFT_SCRIPT = SCRIPT_DIR / "check-draft-schema-mirror.sh"
VECTOR_SCRIPT = SCRIPT_DIR / "check-ctk-vector-mirror.sh"
WORKFLOW = ROOT / ".github/workflows/schema-drift.yml"
MIRROR = Path("sdk/python/python/agent_hooks")
BASH = shutil.which("bash")


class SchemaDriftTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = os.environ.copy()
        self.env.update(
            GIT_AUTHOR_NAME="Test",
            GIT_AUTHOR_EMAIL="test@example.com",
            GIT_COMMITTER_NAME="Test",
            GIT_COMMITTER_EMAIL="test@example.com",
            GITHUB_STEP_SUMMARY="summary",
            PATH=str(self.root / "bin") + os.pathsep + os.environ["PATH"],
        )
        self.write("bin/python3", "#!/bin/sh\nprintf '0.1\\ndraft\\n'\n")
        (self.root / "bin/python3").chmod(0o755)
        for script in (SCHEMA_SCRIPT, DRAFT_SCRIPT, VECTOR_SCRIPT):
            target = Path("sdk/python/scripts") / script.name
            self.write(target, script.read_text(encoding="utf-8"))
        for path in [
            "spec/0.1/schema/generated/root.schema.json",
            MIRROR / "schema/0.1/root.schema.json",
            "spec/draft/schema/generated/root.schema.json",
            MIRROR / "schema/draft/root.schema.json",
        ]:
            self.write(path, "root\n")
        for path in [
            "spec/0.1/schema/generated/strict-contexts/point.schema.json",
            MIRROR / "schema/0.1/agent-context/point.schema.json",
            "spec/draft/schema/generated/strict-contexts/point.schema.json",
            MIRROR / "schema/draft/agent-context/point.schema.json",
        ]:
            self.write(path, "point\n")
        self.write("conformance/0.1/vectors/AH-CTK-1.json", "vector\n")
        self.write(MIRROR / "ctk/vectors/AH-CTK-1.json", "vector\n")
        self.git("init", "-q")
        self.git("config", "core.autocrlf", "false")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    def write(self, path, text):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.root,
            env=self.env,
            check=True,
            capture_output=True,
            text=True,
        )

    def run_script(self, script, *args):
        return subprocess.run(
            [BASH, f"sdk/python/scripts/{script}", *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
        )

    def test_clean_mirrors(self):
        for script in (SCHEMA_SCRIPT.name, DRAFT_SCRIPT.name, VECTOR_SCRIPT.name):
            with self.subTest(script=script):
                result = self.run_script(script)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_released_detects_changed_missing_and_extra(self):
        for action in ("changed", "missing", "extra"):
            with self.subTest(action=action):
                target = self.root / MIRROR / "schema/0.1/root.schema.json"
                if action == "changed":
                    target.write_text("changed\n", encoding="utf-8")
                elif action == "missing":
                    target.unlink()
                else:
                    self.write(MIRROR / "schema/9.9/extra.schema.json", "extra\n")
                self.git("add", "-A")
                self.git("commit", "-qm", "introduce drift")
                self.assertNotEqual(self.run_script(SCHEMA_SCRIPT.name).returncode, 0)
                self.git(
                    "restore", f"--source={self.base}", "--staged", "--worktree", "--", str(MIRROR)
                )
                self.git("commit", "-qm", "restore fixture")

    def test_released_fails_on_source_and_version_errors(self):
        (self.root / "spec/0.1/schema/generated/strict-contexts/point.schema.json").unlink()
        self.assertNotEqual(self.run_script(SCHEMA_SCRIPT.name).returncode, 0)
        self.git(
            "restore", f"--source={self.base}", "--staged", "--worktree", "--", "spec", str(MIRROR)
        )
        self.write("bin/python3", "#!/bin/sh\nexit 2\n")
        self.assertNotEqual(self.run_script(SCHEMA_SCRIPT.name).returncode, 0)

    def test_released_detects_source_change_and_supports_legacy_layout(self):
        source = self.root / "spec/0.1/schema/generated"
        shutil.move(str(source / "root.schema.json"), str(source.parent / "root.schema.json"))
        shutil.move(str(source / "strict-contexts"), str(source.parent / "agent-context"))
        source.rmdir()
        self.assertEqual(self.run_script(SCHEMA_SCRIPT.name).returncode, 0)
        self.write("spec/0.1/schema/root.schema.json", "updated\n")
        self.assertNotEqual(self.run_script(SCHEMA_SCRIPT.name).returncode, 0)

    def test_vectors_detect_changed_missing_and_extra(self):
        for action in ("changed", "missing", "extra"):
            with self.subTest(action=action):
                target = self.root / MIRROR / "ctk/vectors/AH-CTK-1.json"
                if action == "changed":
                    target.write_text("changed\n", encoding="utf-8")
                elif action == "missing":
                    target.unlink()
                else:
                    self.write(MIRROR / "ctk/vectors/extra.json", "extra\n")
                self.git("add", "-A")
                self.git("commit", "-qm", "introduce drift")
                self.assertNotEqual(self.run_script(VECTOR_SCRIPT.name).returncode, 0)
                self.git(
                    "restore", f"--source={self.base}", "--staged", "--worktree", "--", str(MIRROR)
                )
                self.git("commit", "-qm", "restore fixture")

    def test_vectors_fail_when_source_missing_or_new(self):
        source = self.root / "conformance/0.1/vectors/AH-CTK-1.json"
        source.unlink()
        self.assertNotEqual(self.run_script(VECTOR_SCRIPT.name).returncode, 0)
        source.write_text("vector\n", encoding="utf-8")
        self.write("conformance/0.1/vectors/AH-CTK-2.json", "new\n")
        self.assertNotEqual(self.run_script(VECTOR_SCRIPT.name).returncode, 0)

    def test_draft_differences_warn_but_errors_fail(self):
        (self.root / MIRROR / "schema/draft/root.schema.json").unlink()
        result = self.run_script(DRAFT_SCRIPT.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stdout)
        self.assertIn("Advisory only", (self.root / "summary").read_text())
        shutil.rmtree(self.root / MIRROR / "schema/draft")
        self.assertNotEqual(self.run_script(DRAFT_SCRIPT.name).returncode, 0)
        (self.root / "spec/draft/schema/generated/root.schema.json").unlink()
        self.assertNotEqual(self.run_script(DRAFT_SCRIPT.name).returncode, 0)

    def test_workflow_aggregate_rejects_non_success_results(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        aggregate_step = workflow.split(
            "      - name: Require all drift checks to complete successfully\n", 1
        )[1]
        match = re.search(
            r"(?m)^        run: \|\n((?:          .*(?:\n|$))+)",
            aggregate_step,
        )
        self.assertIsNotNone(match)
        aggregate_script = textwrap.dedent(match.group(1))
        names = [
            "SPEC_DRAFT_GENERATED_SCHEMA_CHECK",
            "PYTHON_RELEASED_SCHEMA_MIRROR",
            "PYTHON_CTK_VECTOR_MIRROR",
            "PYTHON_DRAFT_SCHEMA_MIRROR",
        ]
        for position in range(len(names)):
            for status in ("failure", "cancelled", "skipped", ""):
                with self.subTest(position=position, status=status):
                    values = ["success"] * len(names)
                    values[position] = status
                    env = self.env | dict(zip(names, values, strict=True))
                    result = subprocess.run(
                        [BASH, "-c", aggregate_script],
                        cwd=self.root,
                        env=env,
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
        env = self.env | dict(zip(names, ["success"] * len(names), strict=True))
        self.assertEqual(
            subprocess.run([BASH, "-c", aggregate_script], cwd=self.root, env=env).returncode,
            0,
        )

    def test_workflow_wires_focused_scripts_and_aggregate(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("if: ${{ always() }}", workflow)
        self.assertIn(
            "spec-draft-generated-schema-check",
            workflow,
        )
        self.assertIn("python-released-schema-mirror", workflow)
        self.assertIn("python-ctk-vector-mirror", workflow)
        self.assertIn("python-draft-schema-mirror", workflow)
        self.assertIn("check-released-schema-mirror.sh", workflow)
        self.assertIn("check-draft-schema-mirror.sh", workflow)
        self.assertIn("check-ctk-vector-mirror.sh", workflow)
        for job in (
            "spec-draft-generated-schema-check",
            "python-released-schema-mirror",
            "python-ctk-vector-mirror",
            "python-draft-schema-mirror",
        ):
            self.assertIn(f"needs.{job}.result", workflow)


if __name__ == "__main__":
    unittest.main()
