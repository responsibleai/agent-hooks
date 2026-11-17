# Copyright (c) Microsoft. All rights reserved.

"""Refresh the Python CTK vector mirror and fail on staged drift.

Run from the repository root.
"""

import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    mirror = Path("sdk/python/python/agent_hooks/ctk/vectors")
    if mirror.is_symlink():
        mirror.unlink()
    elif mirror.exists():
        shutil.rmtree(mirror)
    mirror.mkdir(parents=True)
    vectors = sorted(Path("conformance/0.1/vectors").glob("AH-CTK-*.json"))
    if not vectors:
        raise FileNotFoundError("no conformance/0.1/vectors/AH-CTK-*.json files")
    for vector in vectors:
        shutil.copy2(vector, mirror)

    subprocess.run(["git", "add", "-A", "--", str(mirror)], check=True)
    return subprocess.run(["git", "diff", "--cached", "--exit-code", "--", str(mirror)]).returncode


if __name__ == "__main__":
    sys.exit(main())
