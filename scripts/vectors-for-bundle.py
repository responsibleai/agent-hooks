#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""List one versioned conformance suite or print its committed grammar.

Released suites live under conformance/<MAJOR.MINOR>/; the draft suite
lives under conformance/draft/. No grammar rewriting or fixture relabeling
is needed: each suite already names its matching specification bundle.

Usage: vectors-for-bundle.py (list|grammar) <bundle> [--root <repository-root>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
DRAFT = "draft"


def check_bundle(root: Path, bundle: str) -> None:
    if bundle != DRAFT and not VERSION.fullmatch(bundle):
        raise SystemExit(f"{bundle!r} is not draft or a MAJOR.MINOR version")
    if not (root / "spec" / bundle).is_dir():
        raise SystemExit(f"spec/{bundle}/ does not exist")
    if not (root / "conformance" / bundle / "vectors").is_dir():
        raise SystemExit(f"conformance/{bundle}/vectors/ does not exist")


def vectors_of(root: Path, bundle: str) -> list[Path]:
    """The vector files of the bundle's suite, in name order."""
    check_bundle(root, bundle)
    paths = sorted((root / "conformance" / bundle / "vectors").glob("AH-CTK-*.json"))
    if not paths:
        raise SystemExit(f"conformance/{bundle}/vectors/ is empty")
    return paths


def grammar_for(root: Path, bundle: str) -> dict:
    """The committed grammar for the selected bundle."""
    check_bundle(root, bundle)
    path = root / "conformance" / bundle / "vectors.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=["list", "grammar"])
    parser.add_argument("bundle", help="draft or a released MAJOR.MINOR")
    parser.add_argument("--root", default=str(ROOT), help="the repository root")
    args = parser.parse_args(argv[1:])
    root = Path(args.root).resolve()
    if args.command == "list":
        for path in vectors_of(root, args.bundle):
            print(path.relative_to(root).as_posix())
    else:
        print(json.dumps(grammar_for(root, args.bundle), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
