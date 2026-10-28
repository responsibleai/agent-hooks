#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Write the JSON Schemas under spec/schema/ from their typed source, or check them.

The source is the ``schemagen`` package beside this script: one module per
root schema, with the per-point agent-context variants derived from the
master there. Every output is a pure function of that source.

  python3 scripts/gen-schemas.py          write all schema files
  python3 scripts/gen-schemas.py --check  write nothing; exit 1 when a committed
                                          file differs from the generated text or
                                          a schema file has no source

The check runs in the CI ``lint`` job; the ``drift`` job regenerates and
diffs as well, together with the vendored copies.
"""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from schemagen import render  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "spec" / "schema"
DIFF_LINES = 40


def committed() -> set[str]:
    found = list(OUT.glob("*.schema.json")) + list(
        OUT.glob("agent-context/*.schema.json")
    )
    return {path.relative_to(OUT).as_posix() for path in found}


def write(files: dict[str, str]) -> int:
    for rel, text in files.items():
        path = OUT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
        print(f"wrote {path.relative_to(ROOT).as_posix()}")
    return 0


def check(files: dict[str, str]) -> int:
    failing = 0
    for rel, text in files.items():
        path = OUT / rel
        if not path.exists():
            failing += 1
            print(
                f"::error::spec/schema/{rel} is missing; run python3 scripts/gen-schemas.py"
            )
            continue
        actual = path.read_bytes().decode("utf-8")
        if actual == text:
            continue
        failing += 1
        print(
            f"::error::spec/schema/{rel} differs from the typed source; "
            "run python3 scripts/gen-schemas.py"
        )
        diff = difflib.unified_diff(
            actual.splitlines(keepends=True),
            text.splitlines(keepends=True),
            f"a/spec/schema/{rel}",
            f"b/spec/schema/{rel}",
        )
        sys.stdout.writelines(list(diff)[:DIFF_LINES])
    for rel in sorted(committed() - files.keys()):
        failing += 1
        print(f"::error::spec/schema/{rel} has no source under scripts/schemagen/")
    print(f"gen-schemas --check: {len(files)} files generated, {failing} failing")
    return 1 if failing else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare the committed files with the generated text instead of writing",
    )
    args = parser.parse_args()
    files = render()
    return check(files) if args.check else write(files)


if __name__ == "__main__":
    sys.exit(main())
