"""Shared helpers for the TCMS maintenance scripts."""
import datetime
from pathlib import Path

import yaml


class TcmsError(Exception):
    """A problem with a test case file that should fail the run."""


def normalize(value):
    """Recursively convert YAML date objects to ISO strings.

    Unquoted dates like `created_at: 2026-07-21` come out of PyYAML as
    datetime.date; the index must be plain JSON and both sides of the system
    treat dates as strings.
    """
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def iter_test_case_files(cases_root):
    """Yield all test case YAML files in deterministic order."""
    return sorted(Path(cases_root).rglob("*.yaml"))


def load_test_case(path):
    """Parse one test case file into a normalized dict, or raise TcmsError."""
    path = Path(path)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise TcmsError("{}: cannot parse YAML: {}".format(path.name, exc)) from exc
    if not isinstance(data, dict):
        raise TcmsError("{}: document must be a mapping, not {}".format(path.name, type(data).__name__))
    return normalize(data)
