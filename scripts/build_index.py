"""Aggregate all test case YAML files into dashboard-data/index.json.

Usage: python scripts/build_index.py [test-cases-dir] [output-file]

Output is deterministic (sorted by id, no timestamps) so re-running on
unchanged input produces a byte-identical file and no spurious commits.
"""
import json
import sys
from pathlib import Path

from tcms_lib import TcmsError, iter_test_case_files, load_test_case


def build_index(cases_root):
    cases_root = Path(cases_root)
    entries = []
    seen = {}
    for path in iter_test_case_files(cases_root):
        data = load_test_case(path)
        tc_id = data.get("id")
        if not isinstance(tc_id, str) or not tc_id:
            raise TcmsError("{}: missing or invalid 'id'".format(path.name))
        if tc_id in seen:
            raise TcmsError("duplicate id {} in {} and {}".format(tc_id, seen[tc_id], path.name))
        seen[tc_id] = path.name
        entry = dict(data)
        entry["path"] = "{}/{}".format(cases_root.name, path.relative_to(cases_root).as_posix())
        entries.append(entry)
    entries.sort(key=lambda e: e["id"])
    return {"version": 1, "test_cases": entries}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cases_root = Path(argv[0]) if len(argv) > 0 else Path("test-cases")
    out_path = Path(argv[1]) if len(argv) > 1 else Path("dashboard-data/index.json")
    try:
        index = build_index(cases_root)
    except TcmsError as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 1
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print("Wrote {} ({} test cases)".format(out_path, len(index["test_cases"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
