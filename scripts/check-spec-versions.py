#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when specification folders are incomplete, mislabelled or stale.

Released specifications live in spec/<MAJOR.MINOR>/, each holding one
AGENT-HOOKS-<MAJOR.MINOR>.md whose header says Released and names the
folder as its version. The working text lives in spec/draft/ as
AGENT-HOOKS-DRAFT.md with Status Draft and Version DRAFT. Every bundle
has a schema/ folder with at least one *.schema.json outside src/ and
examples/; which files a bundle's generator produces is the bundle's
own business, so no other file name is required here. spec/README.md
links every folder. Every $id in a bundle sits under that bundle's
published path, schema/v<MAJOR.MINOR>/ for a release and schema/draft/
for the draft. Each bundle is a specification version of its own with
its own wire string, agent-hooks/<MAJOR.MINOR> or agent-hooks/draft:
no file in a bundle carries another bundle's wire string, and every
`spec` member schema in a bundle's schemas admits the bundle's own
string, the draft's as a constant. Each conformance/<version>/ suite
has a matching schema ID, only same-version external schema refs, and
valid host declarations with the corresponding wire string. The golden
documents and contexts use the released 0.1 contract.

Every entry under spec/ is a regular file or directory whose name does
not start with a dot: a symbolic link, a device or pipe, and a hidden
file such as .gitattributes fail, so nothing in a bundle can point
outside it or rewrite other files on checkout.

The rest of the repository must not name a folder or file that is
gone: a spec/<X.Y.Z> path, or an AGENT-HOOKS-<X.Y>.md whose folder does
not exist. Released folders are frozen and are not scanned, and neither
are the script tests under scripts/, whose fixtures name old layouts on
purpose, nor the proposals under docs/proposals/, which record a design
at a point in time and are not kept current. A placeholder such as
AGENT-HOOKS-<X.Y>.md is not a reference.

Usage: check-spec-versions.py [<repository-root>]
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
HEADER = re.compile(
    r"^> \*\*Status:\*\* (?P<status>[A-Za-z]+) · \*\*Version:\*\* `(?P<version>[^`]+)`"
    r" · \*\*Date:\*\* (?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})\s*$",
    re.M,
)
ID_ORIGIN = "https://responsibleai.github.io/agent-hooks/schema/"
WIRE = re.compile(r"agent-hooks/((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)|draft)")
DRAFT_WIRE = "agent-hooks/draft"
TEXT_SUFFIXES = {".md", ".json", ".ts", ".abnf", ".txt"}
# Folders under schema/ that hold no schema: TypeScript source and instances.
NOT_SCHEMAS = ("src", "examples")

# References the rest of the repository must not make.
OLD_LAYOUT = re.compile(r"\bspec/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\b")
SPEC_FILE = re.compile(r"AGENT-HOOKS-(?P<name>[0-9][0-9.]*|DRAFT)\.md")
SPEC_PATH = re.compile(
    r"spec/(?P<folder>[^/\s`'\"()\[\]#<>]+)/AGENT-HOOKS-(?P<name>[0-9][0-9.]*|DRAFT)\.md"
)
SCAN_SUFFIXES = {
    ".md",
    ".yml",
    ".yaml",
    ".json",
    ".py",
    ".mjs",
    ".mts",
    ".ts",
    ".rs",
    ".cs",
    ".go",
    ".toml",
    ".txt",
    ".abnf",
    ".html",
    ".cfg",
    ".ini",
    ".sh",
    ".ps1",
    ".props",
}
SKIP_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "site",
    ".mkdocs-venv",
    "bin",
    "obj",
}


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


def expected_text(folder: Path) -> str:
    return (
        "AGENT-HOOKS-DRAFT.md"
        if folder.name == "draft"
        else f"AGENT-HOOKS-{folder.name}.md"
    )


def check_text(root: Path, folder: Path) -> list[str]:
    """The one specification text of a bundle and its header line."""
    rel = folder.relative_to(root).as_posix()
    expected = expected_text(folder)
    names = sorted(p.name for p in folder.glob("AGENT-HOOKS-*.md"))
    if names != [expected]:
        return [
            f"{rel} must contain exactly one specification text, {expected}; found {names}"
        ]
    text = (folder / expected).read_text(encoding="utf-8")
    match = HEADER.search(text)
    if not match:
        return [
            f"{rel}/{expected} has no '> **Status:** ... · **Version:** `...` · **Date:** ...' line"
        ]
    status, version = match.group("status"), match.group("version")
    if folder.name == "draft":
        want_status, want_version = "Draft", "DRAFT"
    else:
        want_status, want_version = "Released", folder.name
    errors = []
    if status != want_status:
        errors.append(
            f"{rel}/{expected} header says Status {status}; expected {want_status}"
        )
    if version != want_version:
        errors.append(
            f"{rel}/{expected} header says Version {version}; expected {want_version}"
        )
    return errors


def spec_member_schemas(node: object, path: str = "$"):
    """Every schema of a member named `spec`, with its JSON path."""
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}"
            if key == "properties" and isinstance(value, dict):
                member = value.get("spec")
                if isinstance(member, dict):
                    yield f"{here}.spec", member
            yield from spec_member_schemas(value, here)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from spec_member_schemas(value, f"{path}[{index}]")


def admits(schema: dict, wire: str) -> bool:
    """Whether a `spec` member schema accepts `wire`, by its const, enum
    or pattern; a schema with none of them accepts any string."""
    if "const" in schema:
        return schema["const"] == wire
    if isinstance(schema.get("enum"), list):
        return wire in schema["enum"]
    pattern = schema.get("pattern")
    if isinstance(pattern, str):
        try:
            return re.search(pattern, wire) is not None
        except re.error:
            return False
    return True


def check_bundle(root: Path, folder: Path) -> list[str]:
    errors: list[str] = []
    rel = folder.relative_to(root).as_posix()
    errors.extend(check_text(root, folder))
    schema_dir = folder / "schema"
    schemas: set[Path] = set()
    if not schema_dir.is_dir():
        errors.append(f"{rel}/schema/ is missing")
    else:
        schemas = {
            p
            for p in walk(schema_dir)
            if p.name.endswith(".schema.json")
            and p.is_file()
            and not any(
                part in NOT_SCHEMAS for part in p.relative_to(schema_dir).parts[:-1]
            )
        }
        if not schemas:
            errors.append(
                f"{rel}/schema has no *.schema.json files outside src/ and examples/"
            )
    id_base = ID_ORIGIN + ("draft/" if folder.name == "draft" else f"v{folder.name}/")
    wire = f"agent-hooks/{folder.name}"
    for path in walk(folder):
        if path.is_symlink() or not path.is_file() or path.suffix not in TEXT_SUFFIXES:
            continue
        rel_path = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            try:
                document = json.loads(text)
            except json.JSONDecodeError as exc:
                errors.append(f"{rel_path} is invalid JSON: {exc}")
                continue
            identity = document.get("$id") if isinstance(document, dict) else None
            if isinstance(identity, str) and not identity.startswith(id_base):
                errors.append(
                    f"{rel_path} has $id {escape_data(identity)}; expected one under {id_base}"
                )
            if path in schemas:
                for pointer, member in spec_member_schemas(document):
                    if folder.name == "draft":
                        if member.get("const") != wire:
                            errors.append(
                                f"{rel_path} {pointer} does not pin spec to the "
                                f"constant {wire}; a draft instance carries that "
                                "string only"
                            )
                    elif not admits(member, wire):
                        errors.append(
                            f"{rel_path} {pointer} does not admit {wire}, the "
                            "bundle's own wire string"
                        )
        foreign = sorted({m for m in WIRE.findall(text) if m != folder.name})
        if foreign:
            errors.append(
                f"{rel_path} carries the wire string of another version "
                f"({', '.join('agent-hooks/' + v for v in foreign)}); "
                f"spec/{folder.name}/ carries {wire} only"
            )
    return errors


def check_conformance(root: Path, versions: set[str]) -> list[str]:
    """Each conformance suite and its schema belong to one spec version."""
    errors: list[str] = []
    conformance = root / "conformance"

    def load(path: Path) -> object:
        rel = path.relative_to(root).as_posix()
        if not path.is_file():
            errors.append(f"{rel} is missing")
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{rel} is invalid JSON: {exc}")
            return None

    def expect_wire(rel: str, where: str, value: object, wire: str) -> None:
        if value != wire:
            errors.append(f"{rel}: {where} is {value!r}; the suite requires {wire}")

    for version in sorted(versions | {"draft"}):
        suite = conformance / version
        rel_suite = suite.relative_to(root).as_posix()
        schema_path = suite / "vectors.schema.json"
        schema = load(schema_path)
        expected_id = ID_ORIGIN + (
            "draft/conformance/vectors.schema.json"
            if version == "draft"
            else f"v{version}/conformance/vectors.schema.json"
        )
        if isinstance(schema, dict) and schema.get("$id") != expected_id:
            errors.append(
                f"{schema_path.relative_to(root).as_posix()} has $id "
                f"{schema.get('$id')!r}; expected {expected_id}"
            )
        if not suite.is_dir():
            errors.append(f"{rel_suite}/ is missing")
            continue
        vectors = suite / "vectors"
        if not vectors.is_dir():
            errors.append(f"{rel_suite}/vectors/ is missing")
            continue
        paths = sorted(vectors.glob("AH-CTK-*.json"))
        if not paths:
            errors.append(f"{rel_suite}/vectors/ is empty")
        for path in paths:
            vector = load(path)
            if not isinstance(vector, dict):
                continue
            document = vector.get("host_declaration")
            if (
                isinstance(document, dict)
                and vector.get("host_declaration_invalid") is not True
            ):
                expect_wire(
                    path.relative_to(root).as_posix(),
                    "host_declaration.spec",
                    document.get("spec"),
                    f"agent-hooks/{version}",
                )

        if isinstance(schema, dict):
            references: list[str] = []

            def collect_refs(value: object) -> None:
                if isinstance(value, dict):
                    ref = value.get("$ref")
                    if isinstance(ref, str) and "/schema/" in ref:
                        references.append(ref)
                    for child in value.values():
                        collect_refs(child)
                elif isinstance(value, list):
                    for child in value:
                        collect_refs(child)

            collect_refs(schema)
            expected_prefix = ID_ORIGIN + (
                "draft/" if version == "draft" else f"v{version}/"
            )
            for ref in sorted(set(references)):
                if not ref.startswith(expected_prefix):
                    errors.append(
                        f"{schema_path.relative_to(root).as_posix()} has cross-version "
                        f"$ref {ref}; expected references under {expected_prefix}"
                    )

    for name, member in (("declaration.json", "document"), ("identity.json", "ctx")):
        path = conformance / "golden" / name
        golden = load(path)
        if not isinstance(golden, dict):
            continue
        rel = path.relative_to(root).as_posix()
        if "spec" in golden:
            expect_wire(rel, "spec", golden["spec"], "agent-hooks/0.1")
        for index, fixture in enumerate(golden.get("fixtures") or []):
            inner = fixture.get(member) if isinstance(fixture, dict) else None
            if isinstance(inner, dict):
                expect_wire(
                    rel,
                    f"fixtures[{index}].{member}.spec",
                    inner.get("spec"),
                    "agent-hooks/0.1",
                )
    return errors


def check_references(root: Path, released: set[str]) -> list[str]:
    """Stale references anywhere in the repository outside the frozen folders."""
    errors: list[str] = []
    spec = root / "spec"
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d
            for d in dirnames
            if d not in SKIP_DIRS
            and not (here == spec and d in released)
            and not (here == root / "docs" and d == "proposals")
        )
        for name in sorted(filenames):
            path = here / name
            if (
                path.suffix not in SCAN_SUFFIXES
                or path.is_symlink()
                or not path.is_file()
            ):
                continue
            if (
                here == root / "scripts"
                and name.startswith("test_")
                and name.endswith(".py")
            ):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            rel = path.relative_to(root).as_posix()
            for line_number, line in enumerate(text.splitlines(), start=1):
                if OLD_LAYOUT.search(line):
                    errors.append(
                        f"{rel}:{line_number} names a spec/<MAJOR.MINOR.PATCH> path; "
                        "specification folders are spec/<MAJOR.MINOR>/"
                    )
                for match in SPEC_PATH.finditer(line):
                    target = (
                        spec
                        / match.group("folder")
                        / f"AGENT-HOOKS-{match.group('name')}.md"
                    )
                    if not target.is_file():
                        errors.append(
                            f"{rel}:{line_number} links {match.group(0)}, which does not exist"
                        )
                for match in SPEC_FILE.finditer(line):
                    version = match.group("name")
                    if version == "DRAFT":
                        continue
                    if not (spec / version / match.group(0)).is_file():
                        errors.append(
                            f"{rel}:{line_number} names {match.group(0)}, but spec/{version}/ "
                            "does not hold it"
                        )
    return errors


def check(root: Path) -> list[str]:
    """Every problem under <root>/spec and every stale reference, one message each."""
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
        errors.append("spec/ has no released MAJOR.MINOR folder")

    for folder in folders:
        if folder.name != "draft" and not VERSION.fullmatch(folder.name):
            errors.append(f"spec/{folder.name}/ is not draft or a MAJOR.MINOR version")
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

    errors.extend(check_conformance(root, {p.name for p in versions}))
    errors.extend(check_references(root, {p.name for p in versions}))
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
