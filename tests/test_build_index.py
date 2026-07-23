"""Tests for scripts/build_index.py."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_index  # noqa: E402
from tcms_lib import TcmsError  # noqa: E402

VALID_A = """\
id: TC-0002
title: Second case
suite: checkout
priority: high
status: active
automated: false
steps:
  - action: Do something
    expected: It happens
created_at: 2026-07-21
updated_at: "2026-07-22"
"""

VALID_B = """\
id: TC-0001
title: First case
suite: onboarding
priority: low
status: draft
automated: true
tags:
  - smoke
steps:
  - action: Open the app
"""


class BuildIndexTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.cases = self.root / "test-cases"
        (self.cases / "checkout").mkdir(parents=True)
        (self.cases / "onboarding").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel, content):
        path = self.cases / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_builds_index_sorted_by_id_with_paths_and_normalized_dates(self):
        self.write("checkout/TC-0002.yaml", VALID_A)
        self.write("onboarding/TC-0001.yaml", VALID_B)

        index = build_index.build_index(self.cases)

        self.assertEqual(index["version"], 1)
        ids = [tc["id"] for tc in index["test_cases"]]
        self.assertEqual(ids, ["TC-0001", "TC-0002"])
        second = index["test_cases"][1]
        self.assertEqual(second["path"], "test-cases/checkout/TC-0002.yaml")
        # Unquoted YAML dates must come out as ISO strings, not date objects.
        self.assertEqual(second["created_at"], "2026-07-21")
        self.assertEqual(second["updated_at"], "2026-07-22")
        # The whole index must be JSON-serializable.
        json.dumps(index)

    def test_rejects_duplicate_ids(self):
        self.write("checkout/TC-0001.yaml", VALID_A.replace("TC-0002", "TC-0001"))
        self.write("onboarding/TC-0001.yaml", VALID_B)
        with self.assertRaises(TcmsError) as ctx:
            build_index.build_index(self.cases)
        self.assertIn("TC-0001", str(ctx.exception))

    def test_rejects_unparseable_yaml(self):
        self.write("checkout/TC-0003.yaml", "id: TC-0003\n  bad indent: [\n")
        with self.assertRaises(TcmsError) as ctx:
            build_index.build_index(self.cases)
        self.assertIn("TC-0003", str(ctx.exception))

    def test_rejects_non_mapping_documents(self):
        self.write("checkout/TC-0004.yaml", "- just\n- a\n- list\n")
        with self.assertRaises(TcmsError) as ctx:
            build_index.build_index(self.cases)
        self.assertIn("TC-0004", str(ctx.exception))

    def test_rejects_missing_id(self):
        self.write("checkout/TC-0005.yaml", "title: No id here\n")
        with self.assertRaises(TcmsError):
            build_index.build_index(self.cases)

    def test_main_writes_deterministic_json_file(self):
        self.write("checkout/TC-0002.yaml", VALID_A)
        out = self.root / "dashboard-data" / "index.json"
        code = build_index.main([str(self.cases), str(out)])
        self.assertEqual(code, 0)
        text = out.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        data = json.loads(text)
        self.assertEqual(len(data["test_cases"]), 1)
        # Re-running must produce byte-identical output (no timestamps).
        build_index.main([str(self.cases), str(out)])
        self.assertEqual(out.read_text(encoding="utf-8"), text)

    def test_main_returns_nonzero_on_error(self):
        self.write("checkout/TC-0003.yaml", "id: TC-0003\n  bad indent: [\n")
        out = self.root / "dashboard-data" / "index.json"
        code = build_index.main([str(self.cases), str(out)])
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
