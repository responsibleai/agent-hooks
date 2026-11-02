#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when a change edits a released specification folder.

A released folder is any spec/<MAJOR.MINOR.PATCH>/ directory that already
exists at the base revision. Changes under spec/draft/ and new version
folders are allowed. Inside a released folder one kind of change is
allowed: a new file under schema/examples/. A modified or deleted file
anywhere in the folder, and a new file outside schema/examples/, fail.

Usage: check-released-specs-immutable.py <base-revision> [<head-revision>]
"""

from __future__ import annotations

import re
import subprocess
import sys

VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
EXAMPLES = re.compile(r"^spec/[^/]+/schema/examples/.+")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def released_folders(revision: str) -> set[str]:
    names = git("ls-tree", "-d", "--name-only", revision, "spec/").splitlines()
    return {
        name.removeprefix("spec/")
        for name in names
        if VERSION.fullmatch(name.removeprefix("spec/"))
    }


def changed_paths(base: str, head: str) -> list[tuple[str, str]]:
    """(status, path) for every path that differs between base and head.

    Renames are disabled, so each status is one letter: A, M, D or T."""
    fields = git(
        "diff", "--name-status", "-z", "--no-renames", f"{base}...{head}"
    ).split("\0")
    return [(fields[i], fields[i + 1]) for i in range(0, len(fields) - 1, 2)]


def violation(status: str, path: str, released: set[str]) -> str | None:
    """Why this change is not allowed in a released folder, or None."""
    parts = path.split("/")
    if parts[0] != "spec" or len(parts) <= 2 or parts[1] not in released:
        return None
    if status == "A":
        if EXAMPLES.match(path):
            return None
        return "adds a file outside schema/examples/ in a released specification folder"
    if status == "D":
        return "deletes a file from a released specification folder"
    return "changes a file in a released specification folder"


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    base = argv[1]
    head = argv[2] if len(argv) == 3 else "HEAD"
    released = released_folders(base)
    errors = sorted(
        (path, reason)
        for status, path in changed_paths(base, head)
        if (reason := violation(status, path, released))
    )
    if errors:
        print(
            "::error::Released specification folders are immutable; only new "
            "files under schema/examples/ may be added. Make other changes in "
            "spec/draft/ and publish a new version instead:"
        )
        for path, reason in errors:
            print(f"::error file={path}::{path} {reason}")
        return 1
    print(
        "released specification folders unchanged: "
        + (", ".join(sorted(released)) or "none at base")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
