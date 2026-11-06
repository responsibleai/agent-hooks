#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/vectors-for-bundle.py, on a tree built in
a temporary directory: a released 0.1 bundle, the draft, a grammar with
references into the draft, and one vector per set."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

MODULE_SPEC = importlib.util.spec_from_file_location(
    "vectors_for_bundle", Path(__file__).with_name("vectors-for-bundle.py")
)
assert MODULE_SPEC and MODULE_SPEC.loader
vectors = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(vectors)

ORIGIN = "https://responsibleai.github.io/agent-hooks/schema/"


def write(root: Path, relative: str, value: object) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


class VectorsForBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for bundle, base, files in (
            ("0.1", "v0.1/", ["verdict", "interception-point", "host-declaration-1.0"]),
            (
                "draft",
                "draft/",
                [
                    "verdict",
                    "interception-point",
                    "host-declaration-1.0",
                    "host-declaration-1.1",
                ],
            ),
        ):
            for name in files:
                write(
                    self.root,
                    f"spec/{bundle}/schema/generated/{name}.schema.json",
                    {"$id": f"{ORIGIN}{base}{name}.schema.json", "type": "object"},
                )
            # Source files are not published schemas.
            write(
                self.root,
                f"spec/{bundle}/schema/src/ignored.schema.json",
                {"$id": f"{ORIGIN}{base}ignored.schema.json"},
            )
        self.grammar = {
            "$id": f"{ORIGIN}draft/conformance/vectors.schema.json",
            "type": "object",
            "properties": {
                "verdict": {"$ref": f"{ORIGIN}draft/verdict.schema.json"},
                "at": {
                    "items": {"$ref": f"{ORIGIN}draft/interception-point.schema.json"}
                },
                "host_declaration": {
                    "anyOf": [
                        {"$ref": f"{ORIGIN}draft/host-declaration-1.0.schema.json"},
                        {"$ref": f"{ORIGIN}draft/host-declaration-1.1.schema.json"},
                    ]
                },
                "load": {"$ref": "#/$defs/load"},
            },
            "$defs": {"load": {"type": "object"}},
        }
        write(self.root, "conformance/vectors.schema.json", self.grammar)
        write(self.root, "conformance/vectors/AH-CTK-001-a.json", {"id": "AH-CTK-001"})
        write(
            self.root,
            "conformance/vectors/AH-CTK-002-b.json",
            {"id": "AH-CTK-002", "introduced_in": "draft"},
        )
        write(self.root, "conformance/vectors/AH-CTK-003-c.json", {"id": "AH-CTK-003"})

    def test_each_bundle_lists_its_own_set(self) -> None:
        released = [p.name for p in vectors.vectors_of(self.root, "0.1")]
        self.assertEqual(released, ["AH-CTK-001-a.json", "AH-CTK-003-c.json"])
        draft = [p.name for p in vectors.vectors_of(self.root, "draft")]
        self.assertEqual(draft, ["AH-CTK-002-b.json"])

    def test_the_draft_grammar_is_the_file(self) -> None:
        self.assertEqual(vectors.grammar_for(self.root, "draft"), self.grammar)

    def test_a_released_grammar_is_rebased_and_loses_what_the_bundle_lacks(
        self,
    ) -> None:
        grammar = vectors.grammar_for(self.root, "0.1")
        self.assertEqual(
            grammar["$id"], f"{ORIGIN}v0.1/conformance/vectors.schema.json"
        )
        self.assertEqual(
            grammar["properties"]["verdict"]["$ref"],
            f"{ORIGIN}v0.1/verdict.schema.json",
        )
        self.assertEqual(
            grammar["properties"]["at"]["items"]["$ref"],
            f"{ORIGIN}v0.1/interception-point.schema.json",
        )
        self.assertEqual(
            grammar["properties"]["host_declaration"]["anyOf"],
            [{"$ref": f"{ORIGIN}v0.1/host-declaration-1.0.schema.json"}],
        )
        # Local references and the rest are untouched.
        self.assertEqual(grammar["properties"]["load"], {"$ref": "#/$defs/load"})
        self.assertEqual(grammar["$defs"], self.grammar["$defs"])

    def test_an_unpublished_reference_outside_an_anyof_is_an_error(self) -> None:
        self.grammar["properties"]["only_draft"] = {
            "$ref": f"{ORIGIN}draft/host-declaration-1.1.schema.json"
        }
        write(self.root, "conformance/vectors.schema.json", self.grammar)
        with self.assertRaises(SystemExit) as refused:
            vectors.grammar_for(self.root, "0.1")
        self.assertIn("host-declaration-1.1.schema.json", str(refused.exception))
        self.assertIn("outside an anyOf", str(refused.exception))

    def test_an_anyof_that_would_empty_is_an_error(self) -> None:
        self.grammar["properties"]["host_declaration"]["anyOf"] = [
            {"$ref": f"{ORIGIN}draft/host-declaration-1.1.schema.json"}
        ]
        write(self.root, "conformance/vectors.schema.json", self.grammar)
        with self.assertRaises(SystemExit):
            vectors.grammar_for(self.root, "0.1")

    def test_unknown_bundles_are_refused(self) -> None:
        for bundle in ("0.2", "DRAFT", "0.1.0", "../draft"):
            with self.assertRaises(SystemExit):
                vectors.vectors_of(self.root, bundle)

    def test_main_prints_the_list_and_the_grammar(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = vectors.main(["x", "list", "0.1", "--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(
            output.getvalue(),
            "conformance/vectors/AH-CTK-001-a.json\nconformance/vectors/AH-CTK-003-c.json\n",
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            vectors.main(["x", "grammar", "0.1", "--root", str(self.root)])
        self.assertEqual(
            json.loads(output.getvalue())["$id"],
            f"{ORIGIN}v0.1/conformance/vectors.schema.json",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
