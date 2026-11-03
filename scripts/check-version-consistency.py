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

The script also checks the host declaration contract version (spec
section 7.7.2): the Rust DECLARATION_VERSION must be the current row
of the contract table in the development bundle's
DECLARATION-VERSIONS.md, some row of the SDK release table in
VERSIONING.md must accept it, and the bundle must carry its schema.
The development bundle is spec/draft unless the SPEC_DEV_DIR
environment variable names another folder, as the CI workflows do.

It also checks the specification versions the SDKs support
(VERSIONING.md): the five cores carry the same SPEC_VERSION and
SUPPORTED_SPEC_VERSIONS, every supported version has a spec/<X.Y>/
folder, none says DRAFT, SPEC_VERSION is the highest supported, and the
VERSIONING.md row for the current SDK version lists the same versions.
Finally, sdk/typescript/package.json must not commit platform pins.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The specification bundle SDK development tracks (VERSIONING.md). The
# CI workflows export the same name.
SPEC_DEV_DIR = os.environ.get("SPEC_DEV_DIR", "spec/draft")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# Where each core states the wire string it writes and the
# specification versions it accepts.
SPEC_CONSTANTS = {
    "sdk/rust/core/src/types.rs": (
        r'pub const SPEC_VERSION: &str = "([^"]+)"',
        r"pub const SUPPORTED_SPEC_VERSIONS: &\[&str\] = &\[([^\]]*)\]",
    ),
    "sdk/typescript/src/index.ts": (
        r'export const SPEC_VERSION = "([^"]+)"',
        r"export const SUPPORTED_SPEC_VERSIONS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)",
    ),
    "sdk/python/python/agent_hooks/_types.py": (
        r'SPEC_VERSION: Final\[str\] = "([^"]+)"',
        r"SUPPORTED_SPEC_VERSIONS: Final\[tuple\[str, \.\.\.\]\] = \(([^)]*)\)",
    ),
    "sdk/dotnet/src/AgentHooks/Types.cs": (
        r'public const string Version = "(agent-hooks/[^"]+)"',
        r"public static readonly IReadOnlyList<string> SupportedVersions = \[([^\]]*)\];",
    ),
    "sdk/go/agenthooks/types.go": (
        r'const SpecVersion = "([^"]+)"',
        r"var SupportedSpecVersions = \[\]string\{([^}]*)\}",
    ),
}


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


def check_declaration_versions(
    root: Path = ROOT, spec_dev_dir: str = SPEC_DEV_DIR
) -> int:
    """The host declaration contract version (spec section 7.7.2): the
    Rust constant must be the current row of the contract table in the
    development bundle's DECLARATION-VERSIONS.md, some SDK release row
    in VERSIONING.md must accept it, the supported set must list it,
    and the development bundle must carry its schema."""
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
    contract_table = f"{spec_dev_dir}/DECLARATION-VERSIONS.md"
    release_table = "VERSIONING.md"

    def rows(path: str) -> list[str]:
        return [
            line
            for line in (root / path).read_text(encoding="utf-8").splitlines()
            if line.startswith("|") and f"`{current}`" in line
        ]

    if not any("current" in r for r in rows(contract_table)):
        error(f"{contract_table} has no current row for {current}")
        return 1
    # An SDK release row starts with a backticked tag such as
    # `v0.1.0-beta.2`; the contract-version table never does.
    release_row = re.compile(r"^\|\s*`v\d+\.\d+\.\d+[^`]*`")
    if not any(release_row.match(r) for r in rows(release_table)):
        error(f"{release_table} has no SDK release row accepting {current}")
        return 1
    schema = (
        root
        / spec_dev_dir
        / "schema/generated"
        / f"host-declaration-{current.split('/')[1]}.schema.json"
    )
    if not schema.exists():
        error(f"{schema.relative_to(root).as_posix()} is missing for {current}")
        return 1
    print(f"declaration contract version agrees: {current}")
    return 0


def check_spec_versions(root: Path = ROOT, sdk_version: str | None = None) -> int:
    """The specification versions the SDKs support (VERSIONING.md): the
    five cores agree, every supported version has a spec/<X.Y>/ folder,
    none says DRAFT, SPEC_VERSION is the highest supported, and the
    VERSIONING.md row for the current SDK version lists the same
    versions. `sdk_version` defaults to the Rust manifest's version."""
    constants: dict[str, tuple[str, tuple[str, ...]]] = {}
    for path, (version_pattern, supported_pattern) in SPEC_CONSTANTS.items():
        text = (root / path).read_text(encoding="utf-8")
        version = re.search(version_pattern, text)
        supported = re.search(supported_pattern, text)
        assert version and supported, (
            f"no SPEC_VERSION or SUPPORTED_SPEC_VERSIONS in {path}"
        )
        constants[path] = (
            version.group(1),
            tuple(re.findall(r'"([^"]+)"', supported.group(1))),
        )
    if len(set(constants.values())) != 1:
        error("the SDKs disagree on SPEC_VERSION or SUPPORTED_SPEC_VERSIONS:")
        for path, (version, supported) in constants.items():
            print(f"  {path}: {escape_data(version)}, supported {list(supported)}")
        return 1
    ((spec_version, supported),) = set(constants.values())
    if not supported:
        error("SUPPORTED_SPEC_VERSIONS is empty")
        return 1
    for version in supported:
        if not VERSION.fullmatch(version):
            error(f"SUPPORTED_SPEC_VERSIONS names {version}, not a MAJOR.MINOR version")
            return 1
        if not (root / "spec" / version).is_dir():
            error(
                f"SUPPORTED_SPEC_VERSIONS names {version}, but spec/{version}/ does not exist"
            )
            return 1
    highest = max(supported, key=lambda v: tuple(int(x) for x in v.split(".")))
    if spec_version != f"agent-hooks/{highest}":
        error(
            f"SPEC_VERSION is {spec_version}; the highest supported version "
            f"is {highest}, so it must be agent-hooks/{highest}"
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
    print(
        f"specification versions agree: {spec_version}, supported {', '.join(supported)}"
    )
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


def main() -> int:
    if check_no_committed_platform_pins() != 0:
        return 1
    if check_declaration_versions() != 0:
        return 1
    if check_spec_versions() != 0:
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
    sys.exit(main())
