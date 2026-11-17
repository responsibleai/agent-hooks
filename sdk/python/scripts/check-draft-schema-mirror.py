# Copyright (c) Microsoft. All rights reserved.

"""Report experimental Python draft schema mirror drift as an advisory.

Run from the repository root; comparison errors still fail.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    source = Path("spec/draft/schema/generated")
    with tempfile.TemporaryDirectory() as temporary:
        draft = Path(temporary) / "draft"
        (draft / "agent-context").mkdir(parents=True)
        for src, dst in ((source, draft), (source / "strict-contexts", draft / "agent-context")):
            files = sorted(
                path for path in src.glob("*.schema.json") if not path.name.startswith(".")
            )
            if not files:
                raise FileNotFoundError(f"no schema files in {src}")
            for path in files:
                shutil.copy2(path, dst)

        result = subprocess.run(
            ["diff", "-ru", "sdk/python/python/agent_hooks/schema/draft", str(draft)],
            stdout=subprocess.PIPE,
            text=True,
        )
        if result.returncode not in (0, 1):
            print(result.stdout, end="")
            print("::error::could not compare the draft schema mirror")
            return result.returncode if result.returncode > 1 else 1

        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as summary:
            summary.write("## Experimental draft schema mirror\n")
            if result.returncode == 0:
                summary.write("The SDK draft copies match the current draft schemas.\n")
            else:
                summary.write("The SDK draft copies differ from the current specification draft.\n")
                summary.write(
                    "Advisory only: update these copies alongside matching SDK "
                    "implementation changes.\n"
                )
                summary.write(f"```diff\n{result.stdout}```\n")
        if result.returncode == 1:
            print(
                "::warning::experimental SDK draft schema copies differ from the latest draft; "
                "see the job summary"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
