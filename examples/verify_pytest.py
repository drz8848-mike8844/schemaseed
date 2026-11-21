#!/usr/bin/env python3
"""Verify a generated pytest suite without pytest installed.

The generated test modules import pytest, so this script installs a tiny
stand-in for the two pytest features they use (pytest.raises and
pytest.param) and then runs exactly the assertions the test modules make:
every valid row and every boundary row has to pass, and every negative case
has to fail with the expected schema keyword.

Usage:
    python3 examples/verify_pytest.py examples/ecommerce-orders/pytest
"""

import importlib.util
import os
import sys
import types

SUITE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "ecommerce-orders", "pytest"
)


class _Raises:
    def __init__(self, expected):
        self.expected = expected
        self.value = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            raise AssertionError("expected %s to be raised" % self.expected.__name__)
        if not issubclass(exc_type, self.expected):
            return False
        self.value = exc
        return True


pytest_stub = types.ModuleType("pytest")
pytest_stub.raises = lambda expected: _Raises(expected)
pytest_stub.param = lambda *args, **kwargs: args[0] if args else kwargs
pytest_stub.mark = types.SimpleNamespace(
    parametrize=lambda *args, **kwargs: (lambda function: function)
)
sys.modules["pytest"] = pytest_stub

sys.path.insert(0, SUITE)
import _validator  # noqa: E402

failures = 0
checked = 0
for name in sorted(os.listdir(SUITE)):
    if not name.startswith("test_") or not name.endswith(".py"):
        continue
    spec = importlib.util.spec_from_file_location(name[:-3], os.path.join(SUITE, name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for index, row in enumerate(module.VALID_ROWS):
        try:
            _validator.validate(module.SCHEMA, row)
        except Exception as error:
            failures += 1
            print("FAIL valid row %d of %s: %s" % (index, name, error))

    for index, row in enumerate(module.BOUNDARY_ROWS):
        try:
            _validator.validate(module.SCHEMA, row["data"])
        except Exception as error:
            failures += 1
            print("FAIL boundary row %d of %s: %s" % (index, name, error))

    for case in module.NEGATIVE_CASES:
        checked += 1
        try:
            _validator.validate(module.SCHEMA, case["data"])
        except _validator.ValidationError as error:
            expected = " %s: " % case["keyword"]
            if expected not in str(error):
                failures += 1
                print(
                    "FAIL %s of %s: expected keyword %r, got %s"
                    % (case["kind"], name, case["keyword"], error)
                )
        except Exception as error:
            failures += 1
            print("FAIL %s of %s: raised %r" % (case["kind"], name, error))
        else:
            failures += 1
            print("FAIL %s of %s: the invalid payload was accepted" % (case["kind"], name))

    print(
        "checked %-24s %3d valid rows, %d boundary rows, %3d negative cases"
        % (name, len(module.VALID_ROWS), len(module.BOUNDARY_ROWS), len(module.NEGATIVE_CASES))
    )

print("negative cases checked: %d" % checked)
print("failures: %d" % failures)
sys.exit(1 if failures else 0)
