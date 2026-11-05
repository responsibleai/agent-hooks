#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""The conformance vectors of one specification bundle, and the grammar
that validates them.

conformance/vectors/ is one directory holding two sets. A vector with
`introduced_in: draft` belongs to the draft's set only: it is part of
the working test set for the next version and runs under
agent-hooks/draft. Every other vector is part of the released set,
which the gating runs use; it belongs to every released bundle (0.1
today) and runs under that bundle's version. Binding a test set to a
draft revision is issue #188.

`list <bundle>` prints the files of the bundle's set, one per line,
relative to the repository root.

`grammar <bundle>` prints conformance/vectors.schema.json as the bundle
validates it. For the draft the grammar is printed unchanged. For a
released bundle the grammar's $id and every $ref under the draft's id
base (schema/draft/) move to the bundle's (schema/v<X.Y>/), and a
reference to a schema the bundle does not publish (the draft's
host-declaration-1.1 under 0.1) is dropped from the anyOf that holds
it; a reference outside an anyOf to a schema the bundle lacks is an
error. So each bundle validates its own set with its own schemas, and
the committed grammar stays the single source.

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
ID_ORIGIN = "https://responsibleai.github.io/agent-hooks/schema/"
DRAFT = "draft"


def id_base(bundle: str) -> str:
    """The id base the bundle publishes its schemas under."""
    return ID_ORIGIN + ("draft/" if bundle == DRAFT else f"v{bundle}/")


def check_bundle(root: Path, bundle: str) -> None:
    if bundle != DRAFT and not VERSION.fullmatch(bundle):
        raise SystemExit(f"{bundle!r} is not draft or a MAJOR.MINOR version")
    if not (root / "spec" / bundle).is_dir():
        raise SystemExit(f"spec/{bundle}/ does not exist")


def schema_dir(root: Path, bundle: str) -> Path:
    """The bundle's schema folder: schema/generated/ when it exists, else schema/."""
    generated = root / "spec" / bundle / "schema" / "generated"
    return generated if generated.is_dir() else root / "spec" / bundle / "schema"


def is_draft_only(vector: dict) -> bool:
    return vector.get("introduced_in") == DRAFT


def vectors_of(root: Path, bundle: str) -> list[Path]:
    """The vector files of the bundle's set, in name order."""
    check_bundle(root, bundle)
    out: list[Path] = []
    for path in sorted((root / "conformance" / "vectors").glob("AH-CTK-*.json")):
        vector = json.loads(path.read_text(encoding="utf-8"))
        if is_draft_only(vector) == (bundle == DRAFT):
            out.append(path)
    return out


def published_ids(root: Path, bundle: str) -> set[str]:
    """The paths below the bundle's id base of every schema it publishes."""
    base = id_base(bundle)
    ids: set[str] = set()
    for path in schema_dir(root, bundle).rglob("*.schema.json"):
        if "src" in path.relative_to(root).parts:
            continue
        identity = json.loads(path.read_text(encoding="utf-8")).get("$id")
        if isinstance(identity, str) and identity.startswith(base):
            ids.add(identity[len(base) :])
    return ids


def grammar_for(root: Path, bundle: str) -> dict:
    """conformance/vectors.schema.json as `bundle` validates it."""
    check_bundle(root, bundle)
    grammar = json.loads(
        (root / "conformance" / "vectors.schema.json").read_text(encoding="utf-8")
    )
    if bundle == DRAFT:
        return grammar
    published = published_ids(root, bundle)
    old, new = id_base(DRAFT), id_base(bundle)

    def referenced(node: object) -> str | None:
        """The path below the draft base a `$ref` names, or None."""
        ref = node.get("$ref") if isinstance(node, dict) else None
        if isinstance(ref, str) and ref.startswith(old):
            return ref[len(old) :].split("#", 1)[0]
        return None

    def rebase(node: object, where: str) -> None:
        if isinstance(node, dict):
            identity = node.get("$id")
            if isinstance(identity, str) and identity.startswith(old):
                node["$id"] = new + identity[len(old) :]
            for key in ("anyOf", "oneOf"):
                branches = node.get(key)
                if not isinstance(branches, list):
                    continue
                kept = [
                    b
                    for b in branches
                    if referenced(b) is None or referenced(b) in published
                ]
                if not kept:
                    raise SystemExit(
                        f"{where}/{key}: every branch references a schema that "
                        f"spec/{bundle} does not publish"
                    )
                node[key] = kept
            ref = referenced(node)
            if ref is not None:
                if ref not in published:
                    raise SystemExit(
                        f"{where}: references {ref}, which spec/{bundle} does not "
                        "publish, outside an anyOf"
                    )
                node["$ref"] = new + node["$ref"][len(old) :]
            for key, value in node.items():
                rebase(value, f"{where}/{key}")
        elif isinstance(node, list):
            for index, item in enumerate(node):
                rebase(item, f"{where}[{index}]")

    rebase(grammar, "$")
    return grammar


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
