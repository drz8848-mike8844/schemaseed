# Generated pytest suite

Seed: 5243984732049993 — mode: nested

Run it with:

```
pytest pytest/
```

The suite is self contained: `_validator.py` implements the JSON Schema
keywords the generated data uses, so only pytest is needed.

- `test_customers.py`: 10 valid rows, 24 negative cases (enum-violation, format-violation, length-violation, missing-required, null-violation, type-mismatch)
- `test_products.py`: 10 valid rows, 18 negative cases (format-violation, length-violation, missing-required, null-violation, range-violation, type-mismatch)
- `test_order_items.py`: 10 valid rows, 24 negative cases (enum-violation, format-violation, length-violation, missing-required, null-violation, range-violation, type-mismatch)
