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


def main() -> int:
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
    check_no_committed_platform_pins()
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
