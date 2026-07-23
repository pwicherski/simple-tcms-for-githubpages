"""Validate every test case file against the JSON Schema and repo conventions.

Usage: python scripts/validate_test_cases.py [test-cases-dir] [schema-file]

Checks, per file:
  - parses as YAML and is a mapping
  - conforms to schema/test-case.schema.json
  - file name matches the `id` field (TC-0001.yaml <-> id: TC-0001)
  - parent folder matches the `suite` field
  - no id is used by more than one file
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

from tcms_lib import TcmsError, iter_test_case_files, load_test_case


def validate_all(cases_root, schema_path):
    cases_root = Path(cases_root)
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validator = Draft7Validator(schema)
    errors = []
    seen = {}
    for path in iter_test_case_files(cases_root):
        rel = "{}/{}".format(cases_root.name, path.relative_to(cases_root).as_posix())
        try:
            data = load_test_case(path)
        except TcmsError as exc:
            errors.append(str(exc))
            continue
        for err in sorted(validator.iter_errors(data), key=str):
            where = "/".join(str(p) for p in err.absolute_path)
            errors.append("{}: {}{}".format(rel, where + ": " if where else "", err.message))
        tc_id = data.get("id")
        suite = data.get("suite")
        if isinstance(tc_id, str) and tc_id:
            if path.stem != tc_id:
                errors.append("{}: file name must match id '{}'".format(rel, tc_id))
            if tc_id in seen:
                errors.append("{}: duplicate id '{}' also used by {}".format(rel, tc_id, seen[tc_id]))
            else:
                seen[tc_id] = rel
        if isinstance(suite, str) and suite and path.parent.name != suite:
            errors.append(
                "{}: suite '{}' does not match folder '{}'".format(rel, suite, path.parent.name)
            )
    return errors


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cases_root = Path(argv[0]) if len(argv) > 0 else Path("test-cases")
    schema_path = Path(argv[1]) if len(argv) > 1 else Path("schema/test-case.schema.json")
    errors = validate_all(cases_root, schema_path)
    for error in errors:
        print("error: {}".format(error), file=sys.stderr)
    if errors:
        print("{} problem(s) found".format(len(errors)), file=sys.stderr)
        return 1
    print("All test case files are valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
