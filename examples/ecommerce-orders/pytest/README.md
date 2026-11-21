# Generated pytest suite

Seed: 7740387119995446 — mode: relational

Run it with:

```
pytest pytest/
```

The suite is self contained: `_validator.py` implements the JSON Schema
keywords the generated data uses, so only pytest is needed.

- `test_orders.py`: 20 valid rows, 24 negative cases (enum-violation, format-violation, missing-required, null-violation, range-violation, type-mismatch)
- `test_users.py`: 20 valid rows, 20 negative cases (format-violation, length-violation, missing-required, null-violation, range-violation, type-mismatch)
