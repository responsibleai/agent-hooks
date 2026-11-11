#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when a change edits a released specification or conformance folder.

A released folder is any spec/<MAJOR.MINOR>/ or
conformance/<MAJOR.MINOR>/ directory that already exists at the base
revision. Changes under spec/draft/, conformance/draft/ and new version
folders are allowed. Inside a released specification folder one kind
of change is allowed: a new regular .json file under
schema/examples/<Type>/. A modified or deleted file anywhere in a
released folder, and any other new file, fail.

Everything under spec/ is a regular file in a plainly named directory:
a symbolic link, a gitlink (submodule), an empty, dot, dot-dot or .git
path component, and a file or directory whose name starts with a dot
(.gitattributes, .gitignore, .gitmodules) fail wherever they sit, so no
entry can point outside its folder or rewrite other files on checkout.

Usage: check-released-specs-immutable.py <base-revision> [<head-revision>]
"""

from __future__ import annotations

import re
import subprocess
import sys

RELEASED_ROOTS = ("spec", "conformance")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
EXAMPLE = re.compile(r"^spec/[^/]+/schema/examples/[A-Za-z][A-Za-z0-9]*/[^/]+\.json$")
SYMLINK_MODE = "120000"
REGULAR_FILE = "100644"
REGULAR_MODES = (REGULAR_FILE, "100755")


def escape_data(value: str) -> str:
    """Encode a workflow command message (percent, CR and LF)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(value: str) -> str:
    """Encode a workflow command property such as file=; also : and ,."""
    return escape_data(value).replace(":", "%3A").replace(",", "%2C")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def released_folders(revision: str) -> set[str]:
    """Return released folder paths at the given revision."""
    names = git(
        "ls-tree",
        "-d",
        "--name-only",
        revision,
        *(f"{root}/" for root in RELEASED_ROOTS),
    ).splitlines()
    released: set[str] = set()
    for name in names:
        parts = name.split("/")
        if (
            len(parts) == 2
            and parts[0] in RELEASED_ROOTS
            and VERSION.fullmatch(parts[1])
        ):
            released.add(name)
    return released


def changed_paths(base: str, head: str) -> list[tuple[str, str, str]]:
    """(status, head mode, path) for every path that differs between
    base and head. Renames are disabled, so each status is one letter:
    A, M, D or T. The head mode is 000000 for a deleted path."""
    fields = git("diff", "--raw", "-z", "--no-renames", f"{base}...{head}").split("\0")
    changes = []
    for i in range(0, len(fields) - 1, 2):
        # ":<base mode> <head mode> <base sha> <head sha> <status>"
        _, head_mode, _, _, status = fields[i].lstrip(":").split(" ")
        changes.append((status, head_mode, fields[i + 1]))
    return changes


def violation(status: str, head_mode: str, path: str, released: set[str]) -> str | None:
    """Why this change is not allowed, or None. released holds folder
    paths such as spec/0.1 and conformance/0.1."""
    parts = path.split("/")
    if parts[0] not in RELEASED_ROOTS:
        return None
    if parts[0] == "conformance":
        if len(parts) < 2 or "/".join(parts[:2]) not in released:
            return None
        if status == "A":
            return "adds a file to a released conformance folder"
        if status == "D":
            return "deletes a file from a released conformance folder"
        return "changes a file in a released conformance folder"
    # The entry itself comes first, so a symbolic link or gitlink at
    # any depth, spec itself included, gets its own message. A deleted
    # entry has no head mode and no content to check.
    if status != "D":
        if head_mode == SYMLINK_MODE:
            return "is a symbolic link; specification folders hold regular files only"
        if head_mode not in REGULAR_MODES:
            return f"has git mode {head_mode}; specification folders hold regular files only"
        if any(part == "" or part.startswith(".") for part in parts[1:]):
            return (
                "has an empty path component or one that starts with a dot; "
                "specification folders hold no such entries"
            )
    if len(parts) <= 2 or "/".join(parts[:2]) not in released:
        return None
    if status == "A":
        if head_mode == REGULAR_FILE and EXAMPLE.match(path):
            return None
        return (
            "adds a file to a released specification folder; only a regular "
            ".json file under schema/examples/<Type>/ may be added"
        )
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
        for status, head_mode, path in changed_paths(base, head)
        if (reason := violation(status, head_mode, path, released))
    )
    if errors:
        print(
            "::error::Released specification and conformance folders are "
            "immutable; only new regular .json files under "
            "spec/<version>/schema/examples/<Type>/ may be added. Make other "
            "changes in spec/draft/ or conformance/draft/ and publish a new "
            "version instead:"
        )
        for path, reason in errors:
            print(f"::error file={escape_property(path)}::{escape_data(path)} {reason}")
        return 1
    print(
        "released folders unchanged: " + (", ".join(sorted(released)) or "none at base")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
