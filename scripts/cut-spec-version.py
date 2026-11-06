#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Cut a specification version from the draft.

Copies spec/draft/ to spec/<MAJOR.MINOR>/, renames the text to
AGENT-HOOKS-<MAJOR.MINOR>.md, sets its title and header to Released,
the version and the date, and drops the draft banner. In every text
file of the copy it rewrites the spec/draft/ self-references to the new
folder, the schema id base from schema/draft/ to schema/v<MAJOR.MINOR>/
(schemas and inventories alike) and the draft wire string
agent-hooks/draft to agent-hooks/<MAJOR.MINOR>, so the copy is a
version of its own. The draft itself does not change: it keeps its own
wire string, agent-hooks/draft, before and after the cut. The script
then prints what remains by hand: confirm the copy's schemas, point the
draft banner at the new version, add the spec/README.md row and the
CHANGELOG section, and tag after merge. RELEASING.md has the full
procedure.

Usage: cut-spec-version.py <MAJOR.MINOR> [--date YYYY-MM-DD] [--root <repository-root>]
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
TITLE = "# Agent Hooks Specification — Draft\n"
HEADER = re.compile(
    r"^> \*\*Status:\*\* Draft · \*\*Version:\*\* `DRAFT` · \*\*Date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}\s*$",
    re.M,
)
DRAFT_WIRE = "agent-hooks/draft"
ID_ORIGIN = "https://responsibleai.github.io/agent-hooks/schema/"
TEXT_SUFFIXES = {".md", ".json", ".ts", ".abnf", ".txt"}


def released_text(draft_text: str, version: str, date: str) -> str:
    """The draft's text as the released text of `version`."""
    if not draft_text.startswith(TITLE):
        raise SystemExit(f"the draft does not start with {TITLE.strip()!r}")
    text = (
        f"# Agent Hooks Specification — Version {version}\n" + draft_text[len(TITLE) :]
    )
    # The banner is the first block quote that starts with **Draft:**; it
    # ends at the first blank line.
    banner = re.search(r"\n> \*\*Draft:\*\*.*?\n\n", text, re.S)
    if not banner:
        raise SystemExit("the draft has no '> **Draft:**' banner")
    text = text[: banner.start() + 1] + text[banner.end() :]
    header = f"> **Status:** Released · **Version:** `{version}` · **Date:** {date}"
    text, count = HEADER.subn(header, text, count=1)
    if count != 1:
        raise SystemExit("the draft has no Status Draft / Version DRAFT header line")
    return text.replace(DRAFT_WIRE, f"agent-hooks/{version}")


def cut(root: Path, version: str, date: str) -> list[str]:
    """Create spec/<version>/ from spec/draft/ and return the manual follow-ups."""
    if not VERSION.fullmatch(version):
        raise SystemExit(f"{version!r} is not a MAJOR.MINOR version")
    if not DATE.fullmatch(date):
        raise SystemExit(f"{date!r} is not a YYYY-MM-DD date")
    draft = root / "spec" / "draft"
    target = root / "spec" / version
    if target.exists():
        raise SystemExit(f"{target} already exists; released folders are immutable")
    draft_file = draft / "AGENT-HOOKS-DRAFT.md"
    if not draft_file.is_file():
        raise SystemExit(f"{draft_file} is missing")

    shutil.copytree(draft, target, symlinks=False)
    (target / "AGENT-HOOKS-DRAFT.md").unlink()
    released = released_text(draft_file.read_text(encoding="utf-8"), version, date)
    (target / f"AGENT-HOOKS-{version}.md").write_text(released, encoding="utf-8")
    wire = f"agent-hooks/{version}"
    for path in sorted(target.rglob("*")):
        if path.is_file() and path.suffix in TEXT_SUFFIXES:
            text = path.read_text(encoding="utf-8")
            updated = text.replace("spec/draft/", f"spec/{version}/")
            updated = updated.replace(f"{ID_ORIGIN}draft/", f"{ID_ORIGIN}v{version}/")
            updated = updated.replace(DRAFT_WIRE, wire)
            if updated != text:
                path.write_text(updated, encoding="utf-8")
    return [
        f"confirm the copy's schemas still match their source under schema/v{version}/: "
        f"cd sdk/typescript && npx tsx scripts/generate-schemas.mts --check --spec {version}",
        f"point the draft banner in spec/draft/AGENT-HOOKS-DRAFT.md at {version}",
        f"add the spec/README.md row for {version} and set the previous version to Superseded",
        f"move the CHANGELOG.md bullets under 'Unreleased specification' to 'Specification {version} — {date}'",
        "run the checks listed in RELEASING.md, then after the merge tag the merge commit "
        f"spec/{version}",
    ]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("version", help="the new specification version, MAJOR.MINOR")
    parser.add_argument(
        "--date", default=dt.date.today().isoformat(), help="the release date"
    )
    parser.add_argument("--root", default=str(ROOT), help="the repository root")
    args = parser.parse_args(argv[1:])
    follow_ups = cut(Path(args.root).resolve(), args.version, args.date)
    print(f"cut spec/{args.version} from spec/draft; still to do:")
    for step in follow_ups:
        print(f"  - {step}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
