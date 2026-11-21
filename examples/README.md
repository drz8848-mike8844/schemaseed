# Examples

Two complete runs of the CLI, one per mode. They are checked in so that the
output can be read (and diffed) without running anything.

## ecommerce-orders

    node dist/cli.js generate \
      --input fixtures/ecommerce-orders.openapi.yaml \
      --out examples/ecommerce-orders \
      --formats json,jsonl,csv,sql,ts,pytest --count 20 --relations

The orders live in fixtures/ecommerce-orders.openapi.yaml, the users live in
fixtures/users.yaml, and the order references the user across the
file boundary. The relational mode flattens both documents into two tables
(orders, users) and fills orders.user_id with values that really exist in
users.id — see sql/seed.sql.

  * sql/seed.sql — PostgreSQL script: CREATE TABLE IF NOT EXISTS, the foreign
    key constraints and one INSERT per row. Run it with
    "psql -d mydb -f sql/seed.sql".
  * sql/negatives.sql — the negative cases as SQL, commented out, so that
    PostgreSQL can be seen refusing them.
  * json/, jsonl/, csv/ — the same data in the three text formats;
    json/nested.json holds the document shaped view (parent with its children).
  * ts/ — a TypeScript interface plus a constant per table.
  * pytest/ — a self contained pytest suite: the valid rows, the boundary rows
    and one parametrised test per negative case.

## shop-nested

    node dist/cli.js generate \
      --input fixtures/shop.openapi.yaml \
      --out examples/shop-nested \
      --formats json,jsonl,csv,sql,ts,pytest --count 10

The same command without --relations: the documents keep their nested shape
(the customer holds its orders, the order holds its customer), while the SQL
export stays relational because SQL has no other shape.

## verify_pytest.py

    python3 examples/verify_pytest.py examples/ecommerce-orders/pytest

Checks the generated suite without pytest installed: every valid row and every
boundary row has to pass the generated validator, and every negative case has to
fail with the expected schema keyword.
