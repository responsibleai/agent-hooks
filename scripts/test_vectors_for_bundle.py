#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for the versioned suite selector."""

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
ROOT = Path(__file__).resolve().parent.parent


class VectorsForBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for bundle, base in (("0.1", "v0.1"), ("draft", "draft")):
            (self.root / "spec" / bundle).mkdir(parents=True)
            suite = self.root / "conformance" / bundle
            (suite / "vectors").mkdir(parents=True)
            (suite / "vectors.schema.json").write_text(
                json.dumps({"$id": f"{ORIGIN}{base}/conformance/vectors.schema.json"}),
                encoding="utf-8",
            )
            for identity in (
                ("001", "003") if bundle == "0.1" else ("001", "002", "003")
            ):
                (suite / "vectors" / f"AH-CTK-{identity}.json").write_text(
                    json.dumps({"id": f"AH-CTK-{identity}"}), encoding="utf-8"
                )

    def test_each_bundle_lists_its_own_suite(self) -> None:
        self.assertEqual(
            [p.name for p in vectors.vectors_of(self.root, "0.1")],
            ["AH-CTK-001.json", "AH-CTK-003.json"],
        )
        self.assertEqual(len(vectors.vectors_of(self.root, "draft")), 3)

    def test_each_grammar_is_its_committed_file(self) -> None:
        for bundle in ("0.1", "draft"):
            path = self.root / "conformance" / bundle / "vectors.schema.json"
            self.assertEqual(
                vectors.grammar_for(self.root, bundle),
                json.loads(path.read_text(encoding="utf-8")),
            )

    def test_unknown_bundles_are_refused(self) -> None:
        for bundle in ("0.2", "DRAFT", "0.1.0", "../draft"):
            with self.assertRaises(SystemExit):
                vectors.vectors_of(self.root, bundle)

    def test_missing_and_empty_suites_are_refused(self) -> None:
        for path in (self.root / "conformance/0.1/vectors").glob("*.json"):
            path.unlink()
        with self.assertRaisesRegex(SystemExit, "is empty"):
            vectors.vectors_of(self.root, "0.1")
        (self.root / "conformance/0.1/vectors").rmdir()
        with self.assertRaisesRegex(SystemExit, "does not exist"):
            vectors.vectors_of(self.root, "0.1")

    def test_main_prints_the_list_and_grammar(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = vectors.main(["x", "list", "0.1", "--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(
            output.getvalue(),
            "conformance/0.1/vectors/AH-CTK-001.json\n"
            "conformance/0.1/vectors/AH-CTK-003.json\n",
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            vectors.main(["x", "grammar", "0.1", "--root", str(self.root)])
        self.assertEqual(
            json.loads(output.getvalue())["$id"],
            f"{ORIGIN}v0.1/conformance/vectors.schema.json",
        )


class ReleasedSuiteTest(unittest.TestCase):
    def test_0_1_grammar_uses_released_vocabulary(self) -> None:
        grammar = vectors.grammar_for(ROOT, "0.1")
        self.assertEqual(
            grammar["$defs"]["interceptor_rule"]["properties"]["fault"]["enum"],
            ["raise", "malformed_verdict", "mutate"],
        )
        self.assertNotIn(
            "host_messages_must_contain", grammar["$defs"]["expect"]["properties"]
        )
        self.assertEqual(
            grammar["allOf"][0]["then"]["properties"]["host_declaration"]["$ref"],
            f"{ORIGIN}v0.1/host-declaration-1.0.schema.json",
        )
        for draft_term in ("ctk.managed", "substituted_for"):
            self.assertNotIn(draft_term, json.dumps(grammar))

    def test_released_and_draft_declaration_vectors(self) -> None:
        suites = {}
        for bundle in ("0.1", "draft"):
            loaded = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in vectors.vectors_of(ROOT, bundle)
            ]
            suites[bundle] = {vector["id"]: vector for vector in loaded}
        released, draft = suites["0.1"], suites["draft"]
        self.assertNotIn("AH-CTK-155", released)
        if "AH-CTK-155" in draft:
            self.assertEqual(draft["AH-CTK-155"]["introduced_in"], "draft")
        for identity in ("AH-CTK-156", "AH-CTK-158"):
            if identity in released:
                self.assertNotIn("1.1", released[identity]["title"])

    def test_python_packaged_vectors_match_the_released_suite(self) -> None:
        released = {
            path.name: path.read_bytes() for path in vectors.vectors_of(ROOT, "0.1")
        }
        packaged = {
            path.name: path.read_bytes()
            for path in (ROOT / "sdk/python/python/agent_hooks/ctk/vectors").glob(
                "AH-CTK-*.json"
            )
        }
        self.assertEqual(packaged, released)


if __name__ == "__main__":
    unittest.main(verbosity=2)
