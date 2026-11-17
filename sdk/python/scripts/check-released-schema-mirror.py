# Copyright (c) Microsoft. All rights reserved.

"""Refresh supported released Python schema mirrors and fail on staged drift.

Run from the repository root. The experimental draft mirror is preserved.
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    mirror = Path("sdk/python/python/agent_hooks/schema")
    versions = subprocess.run(
        [sys.executable, "scripts/check-version-consistency.py", "--print-supported"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.splitlines()

    for directory in mirror.glob("*"):
        if not directory.name.startswith(".") and directory.is_dir() and directory.name != "draft":
            shutil.rmtree(directory)

    if not versions:
        raise ValueError("no supported specification versions were reported")
    for version in versions:
        if version == "draft":
            continue
        if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
            print(f"::error::invalid released specification version: {version}")
            return 1
        source = Path("spec") / version / "schema"
        if (source / "generated").is_dir():
            source /= "generated"
        points = source / "strict-contexts"
        if not points.is_dir():
            points = source / "agent-context"
        destination = mirror / version
        (destination / "agent-context").mkdir(parents=True, exist_ok=True)
        for src, dst in ((source, destination), (points, destination / "agent-context")):
            files = sorted(
                path for path in src.glob("*.schema.json") if not path.name.startswith(".")
            )
            if not files:
                raise FileNotFoundError(f"no schema files in {src}")
            for path in files:
                shutil.copy2(path, dst)

    subprocess.run(["git", "add", "-A", "--", str(mirror)], check=True)
    return subprocess.run(["git", "diff", "--cached", "--exit-code", "--", str(mirror)]).returncode


if __name__ == "__main__":
    sys.exit(main())
