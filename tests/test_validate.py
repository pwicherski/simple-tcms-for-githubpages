"""Tests for scripts/validate_test_cases.py."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import validate_test_cases  # noqa: E402

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "test-case.schema.json"

VALID = """\
id: TC-0001
title: A valid case
suite: checkout
priority: high
status: active
automated: false
owner: someone
tags:
  - smoke
preconditions:
  - Logged in
steps:
  - action: Do something
    expected: It happens
created_at: 2026-07-21
updated_at: 2026-07-21
"""


class ValidateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cases = Path(self._tmp.name) / "test-cases"
        self.cases.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel, content):
        path = self.cases / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def errors(self):
        return validate_test_cases.validate_all(self.cases, SCHEMA_PATH)

    def test_valid_tree_has_no_errors(self):
        self.write("checkout/TC-0001.yaml", VALID)
        self.assertEqual(self.errors(), [])

    def test_missing_required_field(self):
        self.write("checkout/TC-0001.yaml", VALID.replace("priority: high\n", ""))
        errs = self.errors()
        self.assertEqual(len(errs), 1)
        self.assertIn("TC-0001.yaml", errs[0])
        self.assertIn("priority", errs[0])

    def test_invalid_enum_value(self):
        self.write("checkout/TC-0001.yaml", VALID.replace("status: active", "status: enabled"))
        errs = self.errors()
        self.assertTrue(any("status" in e for e in errs))

    def test_unknown_extra_field(self):
        self.write("checkout/TC-0001.yaml", VALID + "severity: bad\n")
        errs = self.errors()
        self.assertTrue(any("severity" in e for e in errs))

    def test_step_missing_action(self):
        broken = VALID.replace("  - action: Do something\n", "  - expected: Orphan\n", 1)
        broken = broken.replace("    expected: It happens\n", "", 1)
        self.write("checkout/TC-0001.yaml", broken)
        errs = self.errors()
        self.assertTrue(any("action" in e for e in errs))

    def test_suite_field_must_match_folder(self):
        self.write("onboarding/TC-0001.yaml", VALID)  # suite: checkout, folder onboarding
        errs = self.errors()
        self.assertTrue(any("suite" in e and "onboarding" in e for e in errs))

    def test_filename_must_match_id(self):
        self.write("checkout/TC-0099.yaml", VALID)  # id TC-0001, filename TC-0099
        errs = self.errors()
        self.assertTrue(any("TC-0099" in e for e in errs))

    def test_duplicate_ids_across_suites(self):
        self.write("checkout/TC-0001.yaml", VALID)
        dup = VALID.replace("suite: checkout", "suite: onboarding")
        self.write("onboarding/TC-0001.yaml", dup)
        errs = self.errors()
        self.assertTrue(any("duplicate" in e.lower() for e in errs))

    def test_unparseable_yaml_reports_error_not_crash(self):
        self.write("checkout/TC-0001.yaml", "id: TC-0001\n  bad: [\n")
        errs = self.errors()
        self.assertEqual(len(errs), 1)
        self.assertIn("TC-0001.yaml", errs[0])

    def test_main_exit_codes(self):
        self.write("checkout/TC-0001.yaml", VALID)
        self.assertEqual(validate_test_cases.main([str(self.cases), str(SCHEMA_PATH)]), 0)
        self.write("checkout/TC-0002.yaml", "not: valid\n")
        self.assertNotEqual(validate_test_cases.main([str(self.cases), str(SCHEMA_PATH)]), 0)


if __name__ == "__main__":
    unittest.main()
