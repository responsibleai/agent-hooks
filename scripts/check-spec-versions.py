#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when specification version folders are incomplete or unindexed.

Released specifications live in spec/<MAJOR.MINOR.PATCH>/; ongoing
work lives in spec/draft/. Each folder carries the complete spec bundle,
and spec/README.md lists each folder. Every entry under spec/ is a
regular file or directory whose name does not start with a dot: a
symbolic link, a device or pipe, and a hidden file such as
.gitattributes fail, so nothing in a bundle can point outside it or
rewrite other files on checkout.

Usage: check-spec-versions.py [<repository-root>]
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
REQUIRED_FILES = (
    "DECLARATION-VERSIONS.md",
    "declaration-errors.json",
    "reserved-reasons.json",
    "reserved-warnings.json",
    "schema/generated/agent-context.schema.json",
    "schema/generated/verdict.schema.json",
)
REQUIRED_DIRS = ("schema/src", "schema/generated/strict-contexts")


def escape_data(value: str) -> str:
    """Encode a workflow command message (percent, CR and LF)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def walk(root: Path) -> list[Path]:
    """Every entry below root, without following symbolic links."""
    entries: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in sorted(dirnames) + sorted(filenames):
            entries.append(Path(dirpath) / name)
    return entries


def entry_problem(path: Path) -> str | None:
    """Why this entry may not sit under spec/, or None."""
    if path.is_symlink():
        return "is a symbolic link; specification folders hold regular files only"
    if path.name.startswith("."):
        return "starts with a dot; specification folders hold no hidden files"
    if not (path.is_file() or path.is_dir()):
        return "is not a regular file or directory"
    return None


def check_bundle(root: Path, folder: Path) -> list[str]:
    errors: list[str] = []
    rel = folder.relative_to(root).as_posix()
    if len(list(folder.glob("AGENT-HOOKS-*.md"))) != 1:
        errors.append(f"{rel} must contain exactly one AGENT-HOOKS-*.md file")
    for name in REQUIRED_FILES:
        if not (folder / name).is_file():
            errors.append(f"{rel}/{name} is missing")
    for name in REQUIRED_DIRS:
        if not (folder / name).is_dir():
            errors.append(f"{rel}/{name}/ is missing")
    for path in walk(folder):
        if path.suffix != ".json" or path.is_symlink() or not path.is_file():
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.relative_to(root).as_posix()} is invalid JSON: {exc}")
    return errors


def check(root: Path) -> list[str]:
    """Every problem under <root>/spec, as one message each."""
    spec = root / "spec"
    if spec.is_symlink():
        return [
            "spec is a symbolic link; specification folders hold regular files only"
        ]
    errors: list[str] = []
    readme_path = spec / "README.md"
    if not readme_path.is_file():
        errors.append("spec/README.md is missing")
        readme = ""
    else:
        readme = readme_path.read_text(encoding="utf-8")

    for path in walk(spec):
        problem = entry_problem(path)
        if problem:
            errors.append(f"{path.relative_to(root).as_posix()} {problem}")

    folders = sorted(p for p in spec.iterdir() if p.is_dir() and not p.is_symlink())
    names = {p.name for p in folders}
    if "draft" not in names:
        errors.append("spec/draft/ is missing")
    versions = [p for p in folders if VERSION.fullmatch(p.name)]
    if not versions:
        errors.append("spec/ has no released MAJOR.MINOR.PATCH folder")

    for folder in folders:
        if folder.name != "draft" and not VERSION.fullmatch(folder.name):
            errors.append(
                f"spec/{folder.name}/ is not draft or a MAJOR.MINOR.PATCH version"
            )
            continue
        errors.extend(check_bundle(root, folder))
        if f"]({folder.name}/)" not in readme:
            errors.append(f"spec/README.md does not link spec/{folder.name}/")

    for path in spec.iterdir():
        # Symbolic links and hidden entries were reported above.
        if path.is_symlink() or path.is_dir() or path.name.startswith("."):
            continue
        if path.name != "README.md":
            errors.append(f"spec/{path.name} must live in a version folder")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    root = Path(argv[1]).resolve() if len(argv) == 2 else ROOT
    errors = check(root)
    if errors:
        for error in errors:
            print(f"::error::{escape_data(error)}")
        return 1
    released = ", ".join(
        p.name for p in sorted((root / "spec").iterdir()) if VERSION.fullmatch(p.name)
    )
    print(f"specification folders agree: {released}, draft")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
