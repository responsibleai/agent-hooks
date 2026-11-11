#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Fail when the SDK version surfaces disagree (VERSIONING.md).

One tag releases all SDKs together, so the four version manifests
MUST carry the same version at all times:

  sdk/rust/Cargo.toml            [workspace.package] version  (SemVer)
  sdk/python/pyproject.toml      [project] version            (PEP 440)
  sdk/typescript/package.json    version                      (SemVer)
  sdk/dotnet/Directory.Build.props <Version>                  (SemVer)

Go carries no manifest version: the module version is the git tag.
PEP 440 spells SemVer pre-releases differently (0.1.0-alpha.2 ->
0.1.0a2), so versions are compared after normalizing both spellings.

The script also checks the legacy host declaration contract versions:
the Rust DECLARATION_VERSION must be supported and accepted by an SDK
release row in VERSIONING.md. Each supported released bundle must carry
the schema for its current contract, which the SDK must support. Draft
declarations are selected by spec alone and have no contract table.

It also checks the specification versions the SDKs support
(VERSIONING.md): the five cores carry the same SUPPORTED_SPEC_VERSIONS,
every entry is a released MAJOR.MINOR version or draft and has a
spec/<entry>/ folder, at least one entry is released, and the
VERSIONING.md row for the current SDK version lists the same entries.
With --require-spec-tags, as the release workflow runs it, every
released entry must also carry the tag spec/<X.Y> on an ancestor of
HEAD, so an SDK tag cannot claim a specification version that was
never released; the draft is cut, never tagged. With --print-supported
the script prints the entries one per line, for workflows that loop
over them. Finally, sdk/typescript/package.json must not commit
platform pins.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRAFT = "draft"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# Where each core states the specification versions it supports, as
# spec/<entry>/ folder names.
SUPPORTED_CONSTANTS = {
    "sdk/rust/core/src/types.rs": (
        r"pub const SUPPORTED_SPEC_VERSIONS: &\[&str\] = &\[([^\]]*)\]"
    ),
    "sdk/typescript/src/index.ts": (
        r"export const SUPPORTED_SPEC_VERSIONS: readonly string\[\] = "
        r"Object\.freeze\(\[([^\]]*)\]\)"
    ),
    "sdk/python/python/agent_hooks/_types.py": (
        r"SUPPORTED_SPEC_VERSIONS: Final\[tuple\[str, \.\.\.\]\] = \(([^)]*)\)"
    ),
    "sdk/dotnet/src/AgentHooks/Types.cs": (
        r"public static readonly IReadOnlyList<string> SupportedVersions = \[([^\]]*)\];"
    ),
    "sdk/go/agenthooks/types.go": (
        r"var SupportedSpecVersions = \[\]string\{([^}]*)\}"
    ),
}


def is_released(version: str) -> bool:
    """A released specification version is MAJOR.MINOR; the draft is not."""
    return VERSION.fullmatch(version) is not None


def escape_data(value: str) -> str:
    """Encode a workflow command message (percent, CR and LF)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def error(message: str) -> None:
    print(f"::error::{escape_data(message)}")


def normalize(version: str) -> str:
    """Map a SemVer or PEP 440 pre-release to one canonical spelling."""
    v = version.strip().lower()
    # PEP 440: 0.1.0a2 / 0.1.0b2 / 0.1.0rc2  ->  SemVer-ish dashed form.
    m = re.fullmatch(r"(\d+\.\d+\.\d+)(a|b|rc)(\d+)", v)
    if m:
        word = {"a": "alpha", "b": "beta", "rc": "rc"}[m.group(2)]
        return f"{m.group(1)}-{word}.{m.group(3)}"
    return v


def read_versions(root: Path = ROOT) -> dict[str, str]:
    cargo = (root / "sdk/rust/Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M)
    assert m, "no workspace version in sdk/rust/Cargo.toml"
    versions = {"sdk/rust/Cargo.toml": m.group(1)}

    py = (root / "sdk/python/pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', py, re.M)
    assert m, "no version in sdk/python/pyproject.toml"
    versions["sdk/python/pyproject.toml"] = m.group(1)

    pkg = json.loads((root / "sdk/typescript/package.json").read_text(encoding="utf-8"))
    versions["sdk/typescript/package.json"] = pkg["version"]

    props = (root / "sdk/dotnet/Directory.Build.props").read_text(encoding="utf-8")
    m = re.search(r"<Version>([^<]+)</Version>", props)
    assert m, "no <Version> in sdk/dotnet/Directory.Build.props"
    versions["sdk/dotnet/Directory.Build.props"] = m.group(1)
    return versions


def check_declaration_versions(root: Path = ROOT) -> int:
    """Check SDK legacy contracts against supported released bundles,
    independently of the spec-only draft declaration format."""
    types_rs = (root / "sdk/rust/core/src/types.rs").read_text(encoding="utf-8")
    m = re.search(r'pub const DECLARATION_VERSION: &str = "([^"]+)"', types_rs)
    assert m, "no DECLARATION_VERSION in sdk/rust/core/src/types.rs"
    current = m.group(1)
    m = re.search(
        r"pub const SUPPORTED_DECLARATION_VERSIONS: &\[&str\] = &\[([^\]]*)\]", types_rs
    )
    assert m, "no SUPPORTED_DECLARATION_VERSIONS in sdk/rust/core/src/types.rs"
    if "DECLARATION_VERSION" not in m.group(1) and f'"{current}"' not in m.group(1):
        error(f"SUPPORTED_DECLARATION_VERSIONS does not list {current}")
        return 1
    release_table = "VERSIONING.md"

    def rows(path: str) -> list[str]:
        return [
            line
            for line in (root / path).read_text(encoding="utf-8").splitlines()
            if line.startswith("|") and f"`{current}`" in line
        ]

    # An SDK release row starts with a backticked tag such as
    # `v0.1.0-beta.2`; the contract-version table never does.
    release_row = re.compile(r"^\|\s*`v\d+\.\d+\.\d+[^`]*`")
    if not any(release_row.match(r) for r in rows(release_table)):
        error(f"{release_table} has no SDK release row accepting {current}")
        return 1
    constants = dict(re.findall(r'pub const (\w+): &str = "([^"]+)"', types_rs))
    supported = {
        token.strip('"') if token.startswith('"') else constants.get(token)
        for token in (entry.strip() for entry in m.group(1).split(","))
        if token
    }
    for version in supported_spec_versions(root):
        if not is_released(version):
            continue
        bundle = Path("spec") / version
        contract_table = bundle / "DECLARATION-VERSIONS.md"
        if not (root / contract_table).is_file():
            error(f"{contract_table.as_posix()} is missing")
            return 1
        current_rows = [
            line
            for line in (root / contract_table).read_text(encoding="utf-8").splitlines()
            if re.match(
                r"^\|\s*`agent-hooks-declaration/[^`]+`\s*\|\s*current\s*\|", line
            )
        ]
        if len(current_rows) != 1:
            error(f"{contract_table.as_posix()} must have exactly one current row")
            return 1
        contract = re.findall(r"`([^`]+)`", current_rows[0])[0]
        if contract not in supported:
            error(
                f"SUPPORTED_DECLARATION_VERSIONS does not list {contract} "
                f"from {contract_table.as_posix()}"
            )
            return 1
        schema = (
            root
            / bundle
            / "schema/generated"
            / f"host-declaration-{contract.split('/')[1]}.schema.json"
        )
        if not schema.is_file():
            error(f"{schema.relative_to(root).as_posix()} is missing for {contract}")
            return 1
    print(f"declaration contract version agrees: {current}")
    return 0


def check_spec_versions(root: Path = ROOT, sdk_version: str | None = None) -> int:
    """The specification versions the SDKs support (VERSIONING.md): the
    five cores agree, every entry is a released MAJOR.MINOR version or
    draft and has a spec/<entry>/ folder, at least one entry is
    released, and the VERSIONING.md row for the current SDK version
    lists the same entries. `sdk_version` defaults to the Rust
    manifest's version."""
    supported_by: dict[str, tuple[str, ...]] = {}
    for path, pattern in SUPPORTED_CONSTANTS.items():
        match = re.search(pattern, (root / path).read_text(encoding="utf-8"))
        assert match, f"no SUPPORTED_SPEC_VERSIONS in {path}"
        supported_by[path] = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    if len(set(supported_by.values())) != 1:
        error("the SDKs disagree on SUPPORTED_SPEC_VERSIONS:")
        for path, entries in supported_by.items():
            print(f"  {path}: {escape_data(', '.join(entries))}")
        return 1
    (supported,) = set(supported_by.values())
    if not supported:
        error("SUPPORTED_SPEC_VERSIONS is empty")
        return 1
    for version in supported:
        if version != DRAFT and not is_released(version):
            error(
                f"SUPPORTED_SPEC_VERSIONS names {version}, not a MAJOR.MINOR version or draft"
            )
            return 1
        if not (root / "spec" / version).is_dir():
            error(
                f"SUPPORTED_SPEC_VERSIONS names {version}, but spec/{version}/ does not exist"
            )
            return 1
    if not any(is_released(v) for v in supported):
        error(
            "SUPPORTED_SPEC_VERSIONS names no released version; an SDK supports "
            "at least one spec/<MAJOR.MINOR>/ beside the draft"
        )
        return 1
    if sdk_version is None:
        sdk_version = read_versions(root)["sdk/rust/Cargo.toml"]
    tag = f"v{sdk_version}"
    row = next(
        (
            line
            for line in (root / "VERSIONING.md")
            .read_text(encoding="utf-8")
            .splitlines()
            if re.match(rf"^\|\s*`{re.escape(tag)}`", line)
        ),
        None,
    )
    if row is None:
        error(f"VERSIONING.md has no SDK release row for {tag}")
        return 1
    cells = [cell.strip() for cell in row.strip().strip("|").split("|")]
    listed = tuple(re.findall(r"`([^`]+)`", cells[1])) if len(cells) > 1 else ()
    if listed != supported:
        error(
            f"VERSIONING.md row for {tag} lists specification versions "
            f"{list(listed)}; the SDKs support {list(supported)}"
        )
        return 1
    print(f"specification versions agree: {', '.join(supported)}")
    return 0


def supported_spec_versions(root: Path = ROOT) -> tuple[str, ...]:
    """The Rust core's SUPPORTED_SPEC_VERSIONS; check_spec_versions
    proves the other cores agree."""
    pattern = SUPPORTED_CONSTANTS["sdk/rust/core/src/types.rs"]
    match = re.search(
        pattern, (root / "sdk/rust/core/src/types.rs").read_text(encoding="utf-8")
    )
    assert match, "no SUPPORTED_SPEC_VERSIONS in sdk/rust/core/src/types.rs"
    return tuple(re.findall(r'"([^"]+)"', match.group(1)))


def check_spec_tags(root: Path = ROOT) -> int:
    """Every released specification version the SDKs support carries
    the tag spec/<X.Y> on an ancestor of HEAD (RELEASING.md): the tag
    marks the commit that merged the frozen folder and is pushed before
    any SDK tag that supports the version. The draft has no tag."""
    for version in supported_spec_versions(root):
        if not is_released(version):
            print(f"{version} is not a released version and carries no tag")
            continue
        tag = f"spec/{version}"
        resolved = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "rev-parse",
                "--verify",
                "--quiet",
                f"refs/tags/{tag}^{{commit}}",
            ],
            capture_output=True,
            text=True,
        )
        if resolved.returncode != 0:
            error(
                f"tag {tag} does not exist; push it before tagging an SDK release that supports {version}"
            )
            return 1
        ancestor = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "merge-base",
                "--is-ancestor",
                resolved.stdout.strip(),
                "HEAD",
            ],
            capture_output=True,
            text=True,
        )
        if ancestor.returncode != 0:
            error(
                f"tag {tag} is not an ancestor of HEAD; the SDK tag must contain the released {version} folder"
            )
            return 1
        print(f"tag {tag} is on this history")
    return 0


def check_no_committed_platform_pins(
    package_path: Path = ROOT / "sdk/typescript/package.json",
) -> int:
    """The loader manifest must not pin platform packages; the release
    workflow injects optionalDependencies at publish time."""
    pkg = json.loads(package_path.read_text(encoding="utf-8"))
    if "optionalDependencies" in pkg:
        print(
            "sdk/typescript/package.json commits optionalDependencies; "
            "platform pins are injected at publish time (see release.yml)",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = [] if argv is None else argv
    if argv not in ([], ["--require-spec-tags"], ["--print-supported"]):
        print(
            "usage: check-version-consistency.py [--require-spec-tags | --print-supported]",
            file=sys.stderr,
        )
        return 2
    if argv == ["--print-supported"]:
        for version in supported_spec_versions():
            print(version)
        return 0
    if check_no_committed_platform_pins() != 0:
        return 1
    if check_declaration_versions() != 0:
        return 1
    if check_spec_versions() != 0:
        return 1
    if argv == ["--require-spec-tags"] and check_spec_tags() != 0:
        return 1
    versions = read_versions()
    normalized = {path: normalize(v) for path, v in versions.items()}
    if len(set(normalized.values())) == 1:
        print(f"version surfaces agree: {next(iter(normalized.values()))}")
        return 0
    error("SDK version surfaces disagree (VERSIONING.md):")
    for path, raw in versions.items():
        print(f"  {path}: {raw} (normalized {normalized[path]})")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
