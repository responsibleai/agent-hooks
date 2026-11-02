#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when specification version folders are incomplete or unindexed.

Released specifications live in spec/<MAJOR.MINOR.PATCH>/; ongoing
work lives in spec/draft/. Each folder carries the complete spec bundle,
and spec/README.md lists each folder.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec"
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
REQUIRED_FILES = (
    "DECLARATION-VERSIONS.md",
    "declaration-errors.json",
    "reserved-reasons.json",
    "reserved-warnings.json",
    "schema/generated/agent-context.schema.json",
    "schema/generated/verdict.schema.json",
)
REQUIRED_DIRS = ("schema/src", "schema/generated/strict-contexts")


def check_bundle(folder: Path) -> list[str]:
    errors: list[str] = []
    rel = folder.relative_to(ROOT).as_posix()
    if len(list(folder.glob("AGENT-HOOKS-*.md"))) != 1:
        errors.append(f"{rel} must contain exactly one AGENT-HOOKS-*.md file")
    for name in REQUIRED_FILES:
        if not (folder / name).is_file():
            errors.append(f"{rel}/{name} is missing")
    for name in REQUIRED_DIRS:
        if not (folder / name).is_dir():
            errors.append(f"{rel}/{name}/ is missing")
    for path in folder.rglob("*.json"):
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.relative_to(ROOT).as_posix()} is invalid JSON: {exc}")
    return errors


def main() -> int:
    errors: list[str] = []
    readme_path = SPEC / "README.md"
    if not readme_path.is_file():
        errors.append("spec/README.md is missing")
        readme = ""
    else:
        readme = readme_path.read_text(encoding="utf-8")

    folders = sorted(p for p in SPEC.iterdir() if p.is_dir())
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
        errors.extend(check_bundle(folder))
        if f"]({folder.name}/)" not in readme:
            errors.append(f"spec/README.md does not link spec/{folder.name}/")

    for path in SPEC.iterdir():
        if path.is_file() and path.name != "README.md":
            errors.append(f"spec/{path.name} must live in a version folder")

    if errors:
        for error in errors:
            print(f"::error::{error}")
        return 1
    released = ", ".join(p.name for p in versions)
    print(f"specification folders agree: {released}, draft")
    return 0


if __name__ == "__main__":
    sys.exit(main())
