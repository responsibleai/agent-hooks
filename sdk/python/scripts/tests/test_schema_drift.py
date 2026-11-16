#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Exercise the Python SDK CI schema drift checks against isolated Git repositories."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = Path(__file__).resolve().parents[1] / "check-schema-drift.sh"
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
        (self.root / "sdk/python/scripts").mkdir(parents=True)
        self.write("sdk/python/scripts/check-schema-drift.sh", SCRIPT.read_text(encoding="utf-8"))
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
            ["git", *args], cwd=self.root, env=self.env, check=True,
            capture_output=True, text=True,
        )

    def run_check(self, *args):
        return subprocess.run(
            [BASH, "sdk/python/scripts/check-schema-drift.sh", *args],
            cwd=self.root, env=self.env, capture_output=True, text=True,
        )

    def test_clean_mirrors_and_aggregate(self):
        for mode in ("released", "vectors", "draft"):
            with self.subTest(mode=mode):
                result = self.run_check(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_check("aggregate", *["success"] * 4).returncode, 0)

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
                self.assertNotEqual(self.run_check("released").returncode, 0)
                self.git("restore", f"--source={self.base}", "--staged", "--worktree", "--", str(MIRROR))
                self.git("commit", "-qm", "restore fixture")

    def test_released_fails_on_source_and_version_errors(self):
        (self.root / "spec/0.1/schema/generated/strict-contexts/point.schema.json").unlink()
        self.assertNotEqual(self.run_check("released").returncode, 0)
        self.git("restore", f"--source={self.base}", "--staged", "--worktree", "--", "spec", str(MIRROR))
        self.write("bin/python3", "#!/bin/sh\nexit 2\n")
        self.assertNotEqual(self.run_check("released").returncode, 0)

    def test_released_detects_source_change_and_supports_legacy_layout(self):
        source = self.root / "spec/0.1/schema/generated"
        shutil.move(str(source / "root.schema.json"), str(source.parent / "root.schema.json"))
        shutil.move(str(source / "strict-contexts"), str(source.parent / "agent-context"))
        source.rmdir()
        self.assertEqual(self.run_check("released").returncode, 0)
        self.write("spec/0.1/schema/root.schema.json", "updated\n")
        self.assertNotEqual(self.run_check("released").returncode, 0)

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
                self.assertNotEqual(self.run_check("vectors").returncode, 0)
                self.git("restore", f"--source={self.base}", "--staged", "--worktree", "--", str(MIRROR))
                self.git("commit", "-qm", "restore fixture")

    def test_vectors_fail_when_source_missing(self):
        (self.root / "conformance/0.1/vectors/AH-CTK-1.json").unlink()
        self.assertNotEqual(self.run_check("vectors").returncode, 0)

    def test_vectors_detect_new_source_vector(self):
        self.write("conformance/0.1/vectors/AH-CTK-2.json", "new\n")
        self.assertNotEqual(self.run_check("vectors").returncode, 0)

    def test_draft_differences_warn_but_errors_fail(self):
        (self.root / MIRROR / "schema/draft/root.schema.json").unlink()
        result = self.run_check("draft")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stdout)
        self.assertIn("Advisory only", (self.root / "summary").read_text())
        shutil.rmtree(self.root / MIRROR / "schema/draft")
        self.assertNotEqual(self.run_check("draft").returncode, 0)
        (self.root / "spec/draft/schema/generated/root.schema.json").unlink()
        self.assertNotEqual(self.run_check("draft").returncode, 0)

    def test_aggregate_rejects_every_non_success_and_missing_result(self):
        for position in range(4):
            for status in ("failure", "cancelled", "skipped", ""):
                with self.subTest(position=position, status=status):
                    results = ["success"] * 4
                    results[position] = status
                    self.assertNotEqual(self.run_check("aggregate", *results).returncode, 0)
        self.assertNotEqual(self.run_check("aggregate", *["success"] * 3).returncode, 0)

    def test_workflow_wires_all_results_to_unconditional_aggregate(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("if: ${{ always() }}", workflow)
        self.assertIn(
            "needs: [draft-generated, released-python, ctk-vectors, draft-python-advisory]",
            workflow,
        )
        for job in ("draft-generated", "released-python", "ctk-vectors", "draft-python-advisory"):
            self.assertIn(f"${{{{ needs.{job}.result }}}}", workflow)


if __name__ == "__main__":
    unittest.main()
