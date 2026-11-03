#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/check-released-specs-immutable.py.

Each case builds a small git repository in a temporary directory with
one released folder at the base commit, applies one change, and runs
the script the way the change-class workflow does.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-released-specs-immutable.py")
MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_released_specs_immutable", SCRIPT
)
assert MODULE_SPEC and MODULE_SPEC.loader
guard = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(guard)

# Keep the user's git configuration (signing, hooks, default branch)
# out of the temporary repositories.
GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


class Repo:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.git("init", "-q", "-b", "main")

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.root,
            env=GIT_ENV,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def write(self, relative: str, text: str = "{}\n") -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def remove(self, relative: str) -> None:
        (self.root / relative).unlink()

    def symlink(self, relative: str, target: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, path)

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        return self.commit_index(message)

    def commit_index(self, message: str) -> str:
        """Commit the index as it stands, without staging the work tree."""
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD").strip()

    def gitlink(self, relative: str) -> None:
        """Stage a submodule entry (mode 160000) at relative."""
        head = self.git("rev-parse", "HEAD").strip()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{head},{relative}")

    def guard(self, base: str, head: str = "HEAD") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), base, head],
            cwd=self.root,
            env=GIT_ENV,
            capture_output=True,
            text=True,
        )


class GuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Repo(Path(self.temporary.name))
        self.repo.write("spec/README.md", "# versions\n")
        self.repo.write("spec/draft/AGENT-HOOKS-0.1.md", "# draft\n")
        self.before_release = self.repo.commit("before the release")
        self.repo.write("spec/0.1/AGENT-HOOKS-0.1.md", "# 0.1.0\n")
        self.repo.write("spec/0.1/schema/examples/Verdict/allow.json")
        self.base = self.repo.commit("base")

    def assert_fails(self, message: str) -> str:
        self.repo.commit("change")
        result = self.repo.guard(self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stdout)
        return result.stdout

    def assert_passes(self) -> None:
        self.repo.commit("change")
        result = self.repo.guard(self.base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("released specification folders unchanged: 0.1", result.stdout)

    def test_new_example_in_released_folder_passes(self) -> None:
        self.repo.write("spec/0.1/schema/examples/Verdict/deny.json")
        self.assert_passes()

    def test_draft_change_and_new_version_folder_pass(self) -> None:
        self.repo.write("spec/draft/AGENT-HOOKS-0.1.md", "# draft v2\n")
        self.repo.write("spec/0.2/AGENT-HOOKS-0.2.md", "# 0.2.0\n")
        self.assert_passes()

    def test_modified_released_file_fails(self) -> None:
        self.repo.write("spec/0.1/AGENT-HOOKS-0.1.md", "# edited\n")
        out = self.assert_fails("spec/0.1/AGENT-HOOKS-0.1.md changes a file")
        self.assertIn("::error file=spec/0.1/AGENT-HOOKS-0.1.md::", out)

    def test_modified_released_example_fails(self) -> None:
        self.repo.write("spec/0.1/schema/examples/Verdict/allow.json", '{"a": 1}\n')
        self.assert_fails("spec/0.1/schema/examples/Verdict/allow.json changes a file")

    def test_deleted_released_file_fails(self) -> None:
        self.repo.remove("spec/0.1/schema/examples/Verdict/allow.json")
        self.assert_fails("deletes a file from a released specification folder")

    def test_new_file_outside_examples_fails(self) -> None:
        self.repo.write("spec/0.1/schema/src/verdict.ts", "export {};\n")
        self.assert_fails("adds a file to a released specification folder")

    def test_only_regular_json_under_a_type_directory_may_be_added(self) -> None:
        for relative in (
            "spec/0.1/schema/examples/Verdict/notes.md",
            "spec/0.1/schema/examples/new.json",
            "spec/0.1/schema/examples/Type-2/x.json",
            "spec/0.1/schema/examples/Verdict/nested/x.json",
        ):
            self.repo.write(relative)
            self.assert_fails(
                f"{relative} adds a file to a released specification folder"
            )
            self.repo.remove(relative)
        self.repo.write("spec/0.1/schema/examples/HostDeclaration11/new.json")
        self.assert_passes()

    @unittest.skipIf(os.name == "nt", "git records file modes on POSIX only")
    def test_executable_example_fails(self) -> None:
        relative = "spec/0.1/schema/examples/Verdict/run.json"
        self.repo.write(relative)
        os.chmod(self.repo.root / relative, 0o755)
        self.assert_fails(f"{relative} adds a file to a released specification folder")

    def test_gitlink_fails_everywhere_under_spec(self) -> None:
        self.repo.gitlink("spec/0.1/schema/examples/Verdict/sub")
        self.repo.commit_index("gitlink in a released folder")
        result = self.repo.guard(self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(
            "spec/0.1/schema/examples/Verdict/sub has git mode 160000", result.stdout
        )
        self.repo.gitlink("spec/draft/vendor")
        self.repo.commit_index("gitlink in the draft")
        result = self.repo.guard(self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("spec/draft/vendor has git mode 160000", result.stdout)

    def test_dotfiles_fail_everywhere_under_spec(self) -> None:
        self.repo.write("spec/0.1/schema/examples/Verdict/.gitattributes", "* text\n")
        self.assert_fails(
            "spec/0.1/schema/examples/Verdict/.gitattributes has an empty path"
        )
        self.repo.remove("spec/0.1/schema/examples/Verdict/.gitattributes")
        self.repo.write("spec/draft/.gitignore", "build/\n")
        self.assert_fails("spec/draft/.gitignore has an empty path component")
        self.repo.remove("spec/draft/.gitignore")
        self.repo.write("spec/.gitmodules", "")
        self.assert_fails("spec/.gitmodules has an empty path component")

    def test_spec_itself_as_a_symlink_gets_its_own_message(self) -> None:
        shutil.move(self.repo.root / "spec", self.repo.root / "elsewhere")
        os.symlink("elsewhere", self.repo.root / "spec")
        self.assert_fails("::error file=spec::spec is a symbolic link")

    def test_symlink_fails_everywhere_under_spec(self) -> None:
        self.repo.symlink("spec/0.1/schema/examples/Verdict/link.json", "allow.json")
        self.assert_fails(
            "spec/0.1/schema/examples/Verdict/link.json is a symbolic link"
        )
        self.repo.symlink("spec/draft/link.json", "AGENT-HOOKS-0.1.md")
        self.assert_fails("spec/draft/link.json is a symbolic link")
        self.repo.symlink("spec/0.2", "draft")
        self.assert_fails("spec/0.2 is a symbolic link")

    def test_stale_base_sees_no_released_folder(self) -> None:
        # A base revision that predates the released folder is the
        # failure mode of a frozen pull_request.base.sha: the folder is
        # invisible, so an edit to it passes. The workflow therefore
        # resolves the base from the merge commit's first parent.
        self.repo.write("spec/0.1/AGENT-HOOKS-0.1.md", "# edited\n")
        self.repo.commit("change")
        stale = self.repo.guard(self.before_release)
        self.assertEqual(stale.returncode, 0, stale.stdout + stale.stderr)
        self.assertIn("none at base", stale.stdout)
        current = self.repo.guard(self.base)
        self.assertEqual(current.returncode, 1, current.stdout + current.stderr)
        self.assertIn("changes a file", current.stdout)

    @unittest.skipIf(
        os.name == "nt", "a newline in a file name needs a POSIX file system"
    )
    def test_annotation_encodes_the_path(self) -> None:
        self.repo.write("spec/0.1/odd\nname%.md", "x\n")
        out = self.assert_fails("::error file=spec/0.1/odd%0Aname%25.md::")
        self.assertNotIn("odd\nname", out)


class HelperTest(unittest.TestCase):
    def test_version_pattern_accepts_ascii_digits_only(self) -> None:
        self.assertTrue(guard.VERSION.fullmatch("0.1"))
        self.assertTrue(guard.VERSION.fullmatch("10.22"))
        self.assertIsNone(guard.VERSION.fullmatch("0.1.0"))
        self.assertIsNone(guard.VERSION.fullmatch("0.١"))
        self.assertIsNone(guard.VERSION.fullmatch("01.1"))
        self.assertIsNone(guard.VERSION.fullmatch("0.1-beta"))

    def test_escaping(self) -> None:
        self.assertEqual(
            guard.escape_data("50%\r\n::error::x"), "50%25%0D%0A::error::x"
        )
        self.assertEqual(guard.escape_property("a:b,c%"), "a%3Ab%2Cc%25")

    def test_violation_rules(self) -> None:
        released = {"0.1"}
        self.assertIsNone(guard.violation("M", "100644", "README.md", released))
        self.assertIsNone(guard.violation("M", "100644", "spec/README.md", released))
        self.assertIsNone(guard.violation("M", "100644", "spec/draft/x.md", released))
        self.assertIsNone(guard.violation("A", "100644", "spec/0.2/x.md", released))
        self.assertIsNone(
            guard.violation(
                "A", "100644", "spec/0.1/schema/examples/T/x.json", released
            )
        )
        self.assertIn(
            "changes",
            guard.violation(
                "M", "100644", "spec/0.1/schema/examples/T/x.json", released
            ),
        )
        self.assertIn(
            "deletes", guard.violation("D", "000000", "spec/0.1/x.md", released)
        )
        self.assertIn(
            "adds a file to",
            guard.violation("A", "100644", "spec/0.1/x.md", released),
        )
        self.assertIn(
            "changes", guard.violation("T", "100644", "spec/0.1/x.md", released)
        )
        self.assertIn(
            "symbolic link", guard.violation("A", "120000", "spec/draft/x", released)
        )
        self.assertIn("symbolic link", guard.violation("A", "120000", "spec", released))
        self.assertIn(
            "git mode 160000",
            guard.violation("A", "160000", "spec/draft/sub", released),
        )
        self.assertIn(
            "adds a file to",
            guard.violation(
                "A", "100755", "spec/0.1/schema/examples/T/x.json", released
            ),
        )
        self.assertIsNone(
            guard.violation(
                "A", "100644", "spec/0.1/schema/examples/T2/x.json", released
            )
        )
        # A deletion has no entry to check; only the released rule applies.
        self.assertIsNone(
            guard.violation("D", "000000", "spec/draft/.gitignore", released)
        )
        for path in (
            "spec/0.1/schema/examples/../evil.json",
            "spec/0.1/schema/examples/./T/x.json",
            "spec/0.1/schema/examples/.git/x.json",
            "spec/0.1/schema/examples//x.json",
            "spec/0.1/schema/examples/T/.hidden.json",
            "spec/draft/.gitattributes",
        ):
            self.assertIn(
                "empty path component",
                guard.violation("A", "100644", path, released),
                path,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
