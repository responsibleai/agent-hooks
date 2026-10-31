#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when a change edits a released specification folder.

A released folder is any spec/<MAJOR.MINOR.PATCH>/ directory that already
exists at the base revision. Changes under spec/draft/ and new version
folders are allowed.

Usage: check-released-specs-immutable.py <base-revision> [<head-revision>]
"""

from __future__ import annotations

import re
import subprocess
import sys

VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")


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


def changed_paths(base: str, head: str) -> list[str]:
    fields = git(
        "diff", "--name-status", "-z", "--no-renames", f"{base}...{head}"
    ).split("\0")
    return [fields[i + 1] for i in range(0, len(fields) - 1, 2)]


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    base = argv[1]
    head = argv[2] if len(argv) == 3 else "HEAD"
    released = released_folders(base)
    errors = sorted(
        path
        for path in changed_paths(base, head)
        if path.startswith("spec/")
        and len(path.split("/")) > 2
        and path.split("/")[1] in released
    )
    if errors:
        print(
            "::error::Released specification folders are immutable. "
            "Make changes in spec/draft/ and publish a new version instead:"
        )
        for path in errors:
            print(f"::error file={path}::{path} is in a released specification folder")
        return 1
    print(
        "released specification folders unchanged: "
        + (", ".join(sorted(released)) or "none at base")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
