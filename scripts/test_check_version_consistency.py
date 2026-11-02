#!/usr/bin/env python3
# Copyright (c) Microsoft. All rights reserved.

"""Regression tests for scripts/check-version-consistency.py."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_version_consistency",
    Path(__file__).with_name("check-version-consistency.py"),
)
assert MODULE_SPEC and MODULE_SPEC.loader
check_version_consistency = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(check_version_consistency)


class PlatformPinTest(unittest.TestCase):
    def run_check(self, package):
        with tempfile.TemporaryDirectory() as temporary:
            package_path = Path(temporary) / "package.json"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                result = check_version_consistency.check_no_committed_platform_pins(
                    package_path
                )
            return result, output.getvalue()

    def test_absent_optional_dependencies_pass(self):
        result, output = self.run_check({"name": "agent-hooks"})

        self.assertEqual(result, 0)
        self.assertEqual(output, "")

    def test_committed_optional_dependencies_fail(self):
        result, output = self.run_check(
            {"name": "agent-hooks", "optionalDependencies": {"platform": "1.0.0"}}
        )

        self.assertEqual(result, 1)
        self.assertEqual(
            output,
            "sdk/typescript/package.json commits optionalDependencies; "
            "platform pins are injected at publish time (see release.yml)\n",
        )

    def test_main_enforces_platform_pin_check(self):
        with (
            patch.object(
                check_version_consistency,
                "check_no_committed_platform_pins",
                return_value=1,
            ) as check,
            patch.object(
                check_version_consistency, "check_declaration_versions"
            ) as declarations,
        ):
            self.assertEqual(check_version_consistency.main(), 1)

        check.assert_called_once_with()
        declarations.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
