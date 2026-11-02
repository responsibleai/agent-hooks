#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Stage the specification bundles into the documentation site.

The pages workflow runs this before mkdocs. For every
spec/<MAJOR.MINOR.PATCH>/ folder and for spec/draft/ it writes, under
docs-site/docs/:

  spec/<version>.md   one page per released version
  spec.md             the newest version again, the stable "latest" URL
  spec-draft.md       the draft, its back-link pointed at the version page
  schema/<path>       every generated schema of every version at the path
                      its own $id names (a newer version that publishes
                      the same path wins), the bundle's reserved-reasons
                      and declaration-errors inventories beside the root
                      schemas, and conformance/vectors.schema.json at its
                      own $id path

and docs-site/mkdocs.staged.yml: the committed mkdocs.yml with the
Specification navigation entries generated from the same folders, newest
first, then the draft. Nothing it writes is committed.

Usage: stage-docs-site.py [<repository-root>]
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# The draft banner's link to a released bundle, rewritten to that
# version's page in the site.
BACK_LINK = re.compile(
    r"\]\(\.\./((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"
    r"/AGENT-HOOKS-[0-9]+\.[0-9]+\.md\)"
)
NAV_HEAD = "  - Specification:\n"
INVENTORIES = ("reserved-reasons.json", "declaration-errors.json")


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
    files = sorted(folder.glob("AGENT-HOOKS-*.md"))
    if len(files) != 1:
        raise SystemExit(f"{folder} must contain exactly one AGENT-HOOKS-*.md file")
    return files[0]


def published_path(schema_file: Path) -> str:
    """The path after /schema/ in the file's $id, such as
    v0.1/agent-context/input.schema.json."""
    document = json.loads(schema_file.read_text(encoding="utf-8"))
    identity = document.get("$id")
    if not isinstance(identity, str):
        raise SystemExit(f"{schema_file} has no $id")
    path = urlsplit(identity).path
    marker = "/schema/"
    if marker not in path:
        raise SystemExit(f"{schema_file}: $id {identity} has no /schema/ segment")
    relative = path.split(marker, 1)[1]
    parts = relative.split("/")
    if len(parts) < 2 or any(part in ("", ".", "..") for part in parts):
        raise SystemExit(
            f"{schema_file}: $id {identity} does not name a file under a path"
        )
    return relative


def stage_schemas(
    root: Path, versions_oldest_first: list[str], schema_out: Path
) -> None:
    for version in versions_oldest_first:
        bundle = root / "spec" / version
        prefixes: set[str] = set()
        for file in sorted((bundle / "schema" / "generated").rglob("*.schema.json")):
            relative = published_path(file)
            target = schema_out / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
            prefixes.add(relative.split("/")[0])
        if len(prefixes) != 1:
            raise SystemExit(
                f"spec/{version} schemas publish under {sorted(prefixes)}; expected one path"
            )
        (prefix,) = prefixes
        for name in INVENTORIES:
            shutil.copyfile(bundle / name, schema_out / prefix / name)
    vectors = root / "conformance" / "vectors.schema.json"
    target = schema_out / published_path(vectors)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(vectors, target)


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
    entries.append("      - Draft: spec-draft.md\n")
    return "".join(lines[: start + 1] + entries + lines[end:])


def stage(root: Path) -> list[str]:
    spec = root / "spec"
    docs = root / "docs-site" / "docs"
    versions = released_versions(spec)
    if not versions:
        raise SystemExit("spec/ has no released MAJOR.MINOR.PATCH folder")

    pages = docs / "spec"
    shutil.rmtree(pages, ignore_errors=True)
    pages.mkdir(parents=True)
    for version in versions:
        shutil.copyfile(spec_text(spec / version), pages / f"{version}.md")
    shutil.copyfile(spec_text(spec / versions[0]), docs / "spec.md")
    draft = spec_text(spec / "draft").read_text(encoding="utf-8")
    (docs / "spec-draft.md").write_text(
        BACK_LINK.sub(r"](spec/\1.md)", draft), encoding="utf-8"
    )

    schema_out = docs / "schema"
    shutil.rmtree(schema_out, ignore_errors=True)
    stage_schemas(root, list(reversed(versions)), schema_out)

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
