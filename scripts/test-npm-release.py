#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Run the workflow's actual npm loops offline: python3 scripts/test-npm-release.py."""

import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
DIRS = [
    "npm/linux-x64-gnu",
    "npm/linux-arm64-gnu",
    "npm/darwin-x64",
    "npm/darwin-arm64",
    "npm/win32-x64-msvc",
    ".",
]
NAMES = ["@synthetic/package-" + str(i) for i in range(6)]
STUB = r"""
import json, os, sys
args = sys.argv[1:]
states = json.loads(os.environ['PACKAGE_STATES'])
version = os.environ['V']
channel = os.environ['NPM_CHANNEL']
name = None
code = 99
if len(args) == 3 and args[0] == 'view':
    if args[2] == 'version' and args[1].endswith('@' + version):
        name = args[1][:-(len(version) + 1)]
        if name in states: code = 0 if states[name] == 'existing' else 1
    elif args[2] == 'name' and args[1] in states:
        name = args[1]
        code = 1 if states[name] == 'soft' else 0
elif args == ['publish', '--access', 'public', '--tag', 'latest']:
    name = json.loads(open('package.json').read())['name']
    if name in states: code = 0 if states[name] == 'fresh' else 1
elif len(args) == 4 and args[:2] == ['dist-tag', 'add']:
    if args[2].endswith('@' + version) and args[3] == channel and channel:
        name = args[2][:-(len(version) + 1)]
        if name in states: code = 7 if os.environ['TAG_FAIL'] == name else 0
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(dict(args=args, name=name, code=code)) + '\n')
sys.exit(code)
"""


def production_loop():
    text = (ROOT / ".github/workflows/release.yml").read_text()
    step = text.split(
        "      - name: Publish to npm (platform packages, then the loader package)\n", 1
    )[1]
    script = step.split("        run: |\n", 1)[1].split(
        "        working-directory:", 1
    )[0]
    lines = script.splitlines()
    if any(line and not line.startswith("          ") for line in lines):
        raise ValueError("Unexpected workflow indentation")
    script = "\n".join(line[10:] for line in lines) + "\n"
    # Omit npm installation and package preparation; keep everything after
    # the manifest-writing Node command, including both production loops.
    return script.split("\n'\n", 1)[1]


class NpmReleaseTest(unittest.TestCase):
    def run_case(self, states, *, stable=False, missing=False, tag_fail="", status=0):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Existing Node installation required")
        version = "1.0.0" if stable else "1.0.0-alpha.1"
        channel = "" if stable else "alpha"
        with tempfile.TemporaryDirectory(prefix="npm-release-test-") as temporary:
            root = Path(temporary)
            bindir = root / "bin"
            bindir.mkdir()
            (bindir / "node").symlink_to(node)
            # Always launch the stdlib stub with the running Python interpreter.
            stub = bindir / "npm"
            stub.write_text(
                "#!/bin/sh\nexec "
                + shlex.quote(sys.executable)
                + " "
                + shlex.quote(str(root / "npm-stub.py"))
                + ' "$@"\n'
            )
            stub.chmod(0o700)
            (root / "npm-stub.py").write_text(STUB)
            for index, directory in enumerate(DIRS):
                target = root / directory
                target.mkdir(parents=True, exist_ok=True)
                (target / "package.json").write_text(
                    json.dumps(dict(name=NAMES[index], version=version))
                )
                if directory != "." and not (missing and index == 0):
                    (target / "fixture.node").write_text(
                        "Artifact-presence fixture, never loaded.\n"
                    )
            loop = root / "loop.sh"
            loop.write_text(production_loop())
            env = dict(
                PATH=str(bindir) + ":/usr/bin:/bin",
                V=version,
                NPM_CHANNEL=channel,
                PACKAGE_STATES=json.dumps(dict(zip(NAMES, states))),
                CALL_LOG=str(root / "calls.jsonl"),
                TAG_FAIL=tag_fail,
            )
            result = subprocess.run(
                ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", str(loop)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            calls_path = root / "calls.jsonl"
            calls = (
                [json.loads(line) for line in calls_path.read_text().splitlines()]
                if calls_path.exists()
                else []
            )
            self.assertEqual(result.returncode, status, result.stdout + result.stderr)
            self.assertFalse(any(call["code"] == 99 for call in calls), calls)
            publishes = [c["name"] for c in calls if c["args"][0] == "publish"]
            tags = [c["name"] for c in calls if c["args"][:2] == ["dist-tag", "add"]]
            expected_publishes = []
            for name, state in zip(NAMES, states):
                if missing:
                    break
                if state != "existing":
                    expected_publishes.append(name)
                if state == "hard":
                    break
            self.assertEqual(publishes, expected_publishes)
            eligible = [
                name
                for name, state in zip(NAMES, states)
                if state in ("existing", "fresh")
            ]
            expected_tags = [] if stable or missing or "hard" in states else eligible
            if tag_fail:
                expected_tags = expected_tags[: expected_tags.index(tag_fail) + 1]
            self.assertEqual(tags, expected_tags)
            for call in calls:
                if call["args"][0] == "publish":
                    self.assertEqual(
                        call["args"],
                        ["publish", "--access", "public", "--tag", "latest"],
                    )
                if call["args"][:2] == ["dist-tag", "add"]:
                    self.assertEqual(
                        call["args"],
                        ["dist-tag", "add", call["name"] + "@" + version, channel],
                    )
            if tags:
                first_tag = next(
                    i
                    for i, call in enumerate(calls)
                    if call["args"][:2] == ["dist-tag", "add"]
                )
                self.assertFalse(
                    any(c["args"][0] == "publish" for c in calls[first_tag:])
                )
            if "soft" in states:
                self.assertIn("::warning::", result.stdout)
            if missing:
                self.assertIn("has no native artifact", result.stdout)

    def test_visible(self):
        self.run_case(["existing"] * 6)

    def test_stale_after_success(self):
        self.run_case(["fresh"] * 6)

    def test_stable_fresh(self):
        self.run_case(["fresh"] * 6, stable=True)

    def test_stable_existing(self):
        self.run_case(["existing"] * 6, stable=True)

    def test_mixed_eligibility(self):
        self.run_case(["existing", "fresh", "soft", "fresh", "existing", "fresh"])

    def test_existing_publish_failure(self):
        self.run_case(["hard"] + ["existing"] * 5, status=1)

    def test_soft_first_publication(self):
        self.run_case(["soft"] * 6)

    def test_missing_artifact(self):
        self.run_case(["fresh"] * 6, missing=True, status=1)

    def test_tag_failure(self):
        self.run_case(["fresh"] * 6, tag_fail=NAMES[0], status=7)


if __name__ == "__main__":
    unittest.main(verbosity=2)
