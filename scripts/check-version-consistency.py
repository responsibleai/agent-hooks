#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""Fail when the SDK version surfaces disagree (VERSIONING.md).

One tag releases the spec and all SDKs together, so the four version
manifests MUST carry the same version at all times:

  sdk/rust/Cargo.toml            [workspace.package] version  (SemVer)
  sdk/python/pyproject.toml      [project] version            (PEP 440)
  sdk/typescript/package.json    version                      (SemVer)
  sdk/dotnet/Directory.Build.props <Version>                  (SemVer)

Go carries no manifest version: the module version is the git tag.
PEP 440 spells SemVer pre-releases differently (0.1.0-alpha.2 ->
0.1.0a2), so versions are compared after normalizing both spellings.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def normalize(version: str) -> str:
    """Map a SemVer or PEP 440 pre-release to one canonical spelling."""
    v = version.strip().lower()
    # PEP 440: 0.1.0a2 / 0.1.0b2 / 0.1.0rc2  ->  SemVer-ish dashed form.
    m = re.fullmatch(r"(\d+\.\d+\.\d+)(a|b|rc)(\d+)", v)
    if m:
        word = {"a": "alpha", "b": "beta", "rc": "rc"}[m.group(2)]
        return f"{m.group(1)}-{word}.{m.group(3)}"
    return v


def read_versions() -> dict[str, str]:
    cargo = (ROOT / "sdk/rust/Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M)
    assert m, "no workspace version in sdk/rust/Cargo.toml"
    versions = {"sdk/rust/Cargo.toml": m.group(1)}

    py = (ROOT / "sdk/python/pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', py, re.M)
    assert m, "no version in sdk/python/pyproject.toml"
    versions["sdk/python/pyproject.toml"] = m.group(1)

    pkg = json.loads((ROOT / "sdk/typescript/package.json").read_text(encoding="utf-8"))
    versions["sdk/typescript/package.json"] = pkg["version"]

    props = (ROOT / "sdk/dotnet/Directory.Build.props").read_text(encoding="utf-8")
    m = re.search(r"<Version>([^<]+)</Version>", props)
    assert m, "no <Version> in sdk/dotnet/Directory.Build.props"
    versions["sdk/dotnet/Directory.Build.props"] = m.group(1)
    return versions


def check_declaration_versions() -> int:
    """The host declaration contract version (spec section 7.7.2): the
    Rust constant must have a row in both tables of
    spec/DECLARATION-VERSIONS.md, and the supported set must list it."""
    types_rs = (ROOT / "sdk/rust/core/src/types.rs").read_text(encoding="utf-8")
    m = re.search(r'pub const DECLARATION_VERSION: &str = "([^"]+)"', types_rs)
    assert m, "no DECLARATION_VERSION in sdk/rust/core/src/types.rs"
    current = m.group(1)
    m = re.search(
        r"pub const SUPPORTED_DECLARATION_VERSIONS: &\[&str\] = &\[([^\]]*)\]", types_rs
    )
    assert m, "no SUPPORTED_DECLARATION_VERSIONS in sdk/rust/core/src/types.rs"
    if "DECLARATION_VERSION" not in m.group(1) and f'"{current}"' not in m.group(1):
        print(f"::error::SUPPORTED_DECLARATION_VERSIONS does not list {current}")
        return 1
    table = (ROOT / "spec/DECLARATION-VERSIONS.md").read_text(encoding="utf-8")
    rows = [
        line
        for line in table.splitlines()
        if line.startswith("|") and f"`{current}`" in line
    ]
    if not any("current" in r for r in rows):
        print(f"::error::spec/DECLARATION-VERSIONS.md has no current row for {current}")
        return 1
    # An SDK release row starts with a backticked tag such as
    # `v0.1.0-beta.2`; the contract-version table never does.
    release_row = re.compile(r"^\|\s*`v\d+\.\d+\.\d+[^`]*`")
    if not any(release_row.match(r) for r in rows):
        print(
            f"::error::spec/DECLARATION-VERSIONS.md has no SDK release row accepting {current}"
        )
        return 1
    schema = (
        ROOT / "spec/schema" / f"host-declaration-{current.split('/')[1]}.schema.json"
    )
    if not schema.exists():
        print(f"::error::{schema.relative_to(ROOT)} is missing for {current}")
        return 1
    print(f"declaration contract version agrees: {current}")
    return 0


def main() -> int:
    if check_declaration_versions() != 0:
        return 1
    versions = read_versions()
    normalized = {path: normalize(v) for path, v in versions.items()}
    if len(set(normalized.values())) == 1:
        print(f"version surfaces agree: {next(iter(normalized.values()))}")
        return 0
    print("::error::SDK version surfaces disagree (VERSIONING.md):")
    for path, raw in versions.items():
        print(f"  {path}: {raw} (normalized {normalized[path]})")
    return 1


if __name__ == "__main__":
    sys.exit(main())


def check_no_committed_platform_pins():
    """The loader manifest must not pin platform packages; the release
    workflow injects optionalDependencies at publish time."""
    import json as _json

    with open("sdk/typescript/package.json", encoding="utf-8") as f:
        pkg = _json.load(f)
    if "optionalDependencies" in pkg:
        raise SystemExit(
            "sdk/typescript/package.json commits optionalDependencies; "
            "platform pins are injected at publish time (see release.yml)"
        )


if __name__ == "__main__":
    check_no_committed_platform_pins()
