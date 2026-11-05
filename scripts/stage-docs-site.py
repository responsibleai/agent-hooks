#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Stage the specification bundles into the documentation site.

The pages workflow runs this before mkdocs. For every
spec/<MAJOR.MINOR>/ folder and for spec/draft/ it writes, under
docs-site/docs/:

  spec/<version>.md   one page per released version, from AGENT-HOOKS-<version>.md
  spec/draft.md       the draft, from AGENT-HOOKS-DRAFT.md, its banner link
                      pointed at the version page beside it
  spec.md             the newest released version again, the stable "latest" URL
  schema/<path>       every *.schema.json under a bundle's schema/ (outside
                      src/ and examples/) at the path its own $id names
                      (schema/vX.Y/ for a release, schema/draft/ for the
                      draft); the inventories the bundle carries beside its
                      root schemas; and each conformance/<version>/vectors.schema.json
                      at its own $id path

and docs-site/mkdocs.staged.yml: the committed mkdocs.yml with the
Specification navigation entries generated from the same folders, newest
first, then the draft. Nothing it writes is committed.

A published path is immutable: two bundles may stage the same path only
with identical bytes, so a release that changes a schema must publish
under a new $id path (the generator's ID_BASE). Each versioned vectors schema is staged from conformance/<version>/.
Symbolic links anywhere in a bundle fail the staging.

Usage: stage-docs-site.py [<repository-root>]
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# The draft banner's link to a released text, rewritten to that
# version's page, which sits in the same site folder as the draft page.
BACK_LINK = re.compile(
    r"\]\(\.\./((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))/AGENT-HOOKS-\1\.md\)"
)
NAV_HEAD = "  - Specification:\n"
INVENTORIES = (
    "reserved-reasons.json",
    "reserved-warnings.json",
    "declaration-errors.json",
)
SYMLINK = "is a symbolic link; specification bundles hold regular files only"


def escape_data(value: str) -> str:
    """Encode text that may reach a workflow log (percent, CR and LF)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def released_versions(spec: Path) -> list[str]:
    """Released folder names, newest first."""
    names = [
        p.name
        for p in spec.iterdir()
        if p.is_dir() and not p.is_symlink() and VERSION.fullmatch(p.name)
    ]
    return sorted(
        names, key=lambda n: tuple(int(x) for x in n.split(".")), reverse=True
    )


def spec_text(folder: Path) -> Path:
    """The one specification text of a bundle: AGENT-HOOKS-<folder>.md,
    or AGENT-HOOKS-DRAFT.md for the draft."""
    expected = (
        "AGENT-HOOKS-DRAFT.md"
        if folder.name == "draft"
        else f"AGENT-HOOKS-{folder.name}.md"
    )
    files = sorted(folder.glob("AGENT-HOOKS-*.md"))
    if [f.name for f in files] != [expected]:
        raise SystemExit(
            f"{folder} must contain exactly one specification text, {expected}"
        )
    if files[0].is_symlink():
        raise SystemExit(f"{files[0]} {SYMLINK}")
    return files[0]


def published_path(schema_file: Path) -> str:
    """The path after /schema/ in the file's $id, such as
    draft/agent-context/input.schema.json."""
    document = json.loads(schema_file.read_text(encoding="utf-8"))
    identity = document.get("$id")
    if not isinstance(identity, str):
        raise SystemExit(f"{schema_file} has no $id")
    if any(ord(c) < 32 or c == "\x7f" for c in identity):
        raise SystemExit(f"{schema_file}: $id contains control characters")
    path = urlsplit(identity).path
    marker = "/schema/"
    if marker not in path:
        raise SystemExit(
            f"{schema_file}: $id {escape_data(identity)} has no /schema/ segment"
        )
    relative = path.split(marker, 1)[1]
    parts = relative.split("/")
    if len(parts) < 2 or any(part in ("", ".", "..") for part in parts):
        raise SystemExit(
            f"{schema_file}: $id {escape_data(identity)} does not name a file under a path"
        )
    return relative


class Publisher:
    """Writes files under schema/ and keeps every published path immutable."""

    def __init__(self, schema_out: Path) -> None:
        self.schema_out = schema_out
        self.staged: dict[str, tuple[str, bytes]] = {}

    def publish(self, source: Path, relative: str, origin: str) -> None:
        if source.is_symlink():
            raise SystemExit(f"{source} {SYMLINK}")
        data = source.read_bytes()
        earlier = self.staged.get(relative)
        if earlier is not None and earlier[1] != data:
            raise SystemExit(
                f"{origin} and {earlier[0]} both publish schema/{relative} with different "
                "content; a published $id path is immutable, so the newer bundle must "
                "publish under its own path (set ID_BASE in "
                "sdk/typescript/scripts/generate-schemas.mts before regenerating)"
            )
        self.staged[relative] = (origin, data)
        target = self.schema_out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def bundle_schemas(root: Path) -> list[Path]:
    """Every *.schema.json under a bundle's schema/ folder, refusing
    symbolic links on the way; src/ holds TypeScript and examples/ hold
    instances, so neither contributes a schema."""
    if root.is_symlink():
        raise SystemExit(f"{root} {SYMLINK}")
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in sorted(dirnames) + sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink():
                raise SystemExit(f"{path} {SYMLINK}")
            if path.is_file() and name.endswith(".schema.json"):
                files.append(path)
        dirnames[:] = [d for d in sorted(dirnames) if d not in ("src", "examples")]
    return sorted(files)


def stage_schemas(root: Path, bundles: list[str], schema_out: Path) -> None:
    publisher = Publisher(schema_out)
    for name in bundles:
        bundle = root / "spec" / name
        origin = f"spec/{name}"
        prefixes: set[str] = set()
        for file in bundle_schemas(bundle / "schema"):
            relative = published_path(file)
            publisher.publish(file, relative, origin)
            prefixes.add(relative.split("/")[0])
        if len(prefixes) != 1:
            raise SystemExit(
                f"{origin} schemas publish under {sorted(prefixes)}; expected one path"
            )
        (prefix,) = prefixes
        # A bundle carries the inventories of its time; 0.1 predates
        # reserved-warnings.json, so only the files present are published.
        for inventory in INVENTORIES:
            source = bundle / inventory
            if not (source.is_file() or source.is_symlink()):
                continue
            relative = published_path(source)
            if relative != f"{prefix}/{inventory}":
                raise SystemExit(
                    f"{origin}/{inventory}: $id names schema/{relative}; the bundle "
                    f"publishes under schema/{prefix}/"
                )
            publisher.publish(source, relative, origin)
    for name in bundles:
        vectors = root / "conformance" / name / "vectors.schema.json"
        publisher.publish(
            vectors, published_path(vectors), f"conformance/{name}/vectors.schema.json"
        )


def staged_config(config: str, versions: list[str]) -> str:
    """mkdocs.yml with the Specification entries regenerated: one per
    released version, newest first, then the draft."""
    lines = config.splitlines(keepends=True)
    if NAV_HEAD not in lines:
        raise SystemExit("docs-site/mkdocs.yml has no '  - Specification:' nav entry")
    start = lines.index(NAV_HEAD)
    end = start + 1
    while end < len(lines) and lines[end].startswith("      "):
        end += 1
    entries = [f'      - "{v}": spec/{v}.md\n' for v in versions]
    entries.append("      - Draft: spec/draft.md\n")
    return "".join(lines[: start + 1] + entries + lines[end:])


def stage(root: Path) -> list[str]:
    spec = root / "spec"
    docs = root / "docs-site" / "docs"
    versions = released_versions(spec)
    if not versions:
        raise SystemExit("spec/ has no released MAJOR.MINOR folder")

    pages = docs / "spec"
    shutil.rmtree(pages, ignore_errors=True)
    pages.mkdir(parents=True)
    for version in versions:
        shutil.copyfile(spec_text(spec / version), pages / f"{version}.md")
    shutil.copyfile(spec_text(spec / versions[0]), docs / "spec.md")
    draft = spec_text(spec / "draft").read_text(encoding="utf-8")
    (pages / "draft.md").write_text(BACK_LINK.sub(r"](\1.md)", draft), encoding="utf-8")

    schema_out = docs / "schema"
    shutil.rmtree(schema_out, ignore_errors=True)
    # Oldest release first, the draft last, so a conflict names the
    # bundle that arrived later.
    stage_schemas(root, [*reversed(versions), "draft"], schema_out)

    config = (root / "docs-site" / "mkdocs.yml").read_text(encoding="utf-8")
    (root / "docs-site" / "mkdocs.staged.yml").write_text(
        staged_config(config, versions), encoding="utf-8"
    )
    return versions


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    root = Path(argv[1]).resolve() if len(argv) == 2 else ROOT
    versions = stage(root)
    print(
        f"staged specification versions {', '.join(versions)} and the draft; "
        f"spec.md is {versions[0]}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
