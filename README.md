# SchemaSeed

Deterministic seed data, runnable SQL and negative test cases from an OpenAPI 3.x or JSON Schema document.

## Support this project

SchemaSeed is free forever: MIT licensed, no account, no telemetry, no usage limit.
It runs entirely on your machine - your schema file is never uploaded anywhere.

If it saved you time, you can support its maintenance:

- PayPal: https://www.paypal.com/ncp/payment/4YUKW9YBSV57A
- 爱发电 (Alipay / WeChat): https://afdian.com/a/drz8848
- Sponsorship page: https://schemaseed.drz8848.win/support
- Source: https://github.com/drz8848-mike8844/schemaseed
- Issues and feature requests: https://github.com/drz8848-mike8844/schemaseed/issues

Sponsorship buys maintenance time, not features: the core stays free and open source.

## Install

```bash
npm install -g @wenlu8848/schemaseed
# or run it without installing:
npx --yes @wenlu8848/schemaseed --help
```

## Quick start

```bash
schemaseed generate --input openapi.yaml --out ./seed --formats sql,pytest --count 50
cd ./seed && ls sql pytest
```

Requires Node.js 22.6 or newer. The package has no runtime dependencies.

## What problem does this solve

Schema-driven fake data usually stops at one document at a time: a JSON blob that satisfies one schema, with nothing guaranteeing that a value in one document refers to a value that actually exists in another. SchemaSeed reads a whole schema set — an OpenAPI document, a JSON Schema file, or both — resolves the `$ref`s between them, projects the result onto relational tables, and fills every foreign key with a value that really exists in the referenced table. It then writes the data out in the formats a test environment needs: PostgreSQL scripts that run as-is, CSV and JSON for bulk loading, TypeScript constants, and a pytest suite that contains both the valid rows and one negative case per violated constraint. Every run is driven by a seeded PRNG, so the same input and the same seed always produce byte-identical output.

Unlike [json-schema-faker](https://json-schema-faker.js.org/), which generates a JSON value for a single JSON Schema and leaves the relational shape to you, and unlike [@faker-js/faker](https://fakerjs.dev), which hands you random primitives to place yourself, SchemaSeed works across a schema set and ships runnable SQL. It also generates the negative side of the fixture: the row that breaks the enum, the out-of-range number, the missing required field.

## Output example

Real output from `examples/ecommerce-orders/sql/seed.sql` in this repository. The CHECK constraints are not decoration: they are read out of the schema itself - the enum membership on `status`, the range on `total` and `quantity`, the length on `name` - so the generated table carries exactly the rules the document declared. The order rows below point at user ids that the script also inserts:

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" UUID,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "age" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "users_name_check" CHECK (char_length("name") >= 2 AND char_length("name") <= 40),
  CONSTRAINT "users_age_check" CHECK ("age" >= 0 AND "age" <= 120)
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id" UUID,
  "user_id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "total" NUMERIC NOT NULL,
  "quantity" INTEGER NOT NULL,
  "email" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_status_check" CHECK ("status" IN ('pending', 'paid', 'shipped', 'cancelled')),
  CONSTRAINT "orders_total_check" CHECK ("total" >= 0 AND "total" <= 100000),
  CONSTRAINT "orders_quantity_check" CHECK ("quantity" >= 1 AND "quantity" <= 99)
);

DO $schema_seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_user_id_fkey') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id");
  END IF;
END
$schema_seed$;

-- ... the row inserts for both tables follow ...

INSERT INTO "orders" ("id", "user_id", "status", "total", "quantity", "email", "created_at")
  VALUES ('9cf164b6-13b3-451e-9cd8-65b17d05230d', '4925a814-177f-4a82-9a24-76ec4abc2553', 'paid', 150, 23, 'kai.petrov423@example.org', '2025-05-06T18:56:27.000Z')
  ON CONFLICT DO NOTHING;
```

The script is wrapped in a transaction, uses `CREATE TABLE IF NOT EXISTS`, adds the foreign key only when it is missing, and writes every insert with `ON CONFLICT DO NOTHING`, so it is safe to run against an empty database or an existing one. `sql/negatives.sql` holds the matching negative cases, commented out, so PostgreSQL can be seen refusing them.

## Determinism

The same input and the same seed always produce the same output. The seed defaults to a value derived from the input document; pass `--seed` to pin it yourself:

```bash
schemaseed generate --input openapi.yaml --out ./a --seed 42
schemaseed generate --input openapi.yaml --out ./b --seed 42
diff -r ./a ./b && echo identical
```

Because the output is stable, generated fixtures can be committed to a repository and diffed like any other source file.

## CLI reference

```
schemaseed generate --input <file> --out <dir> [options]
schemaseed validate --input <file>
schemaseed inspect  --input <file>
```

### generate

| Option | Description |
| --- | --- |
| `--input`, `-i` | the schema document to read (required) |
| `--out`, `-o` | where the generated files are written (required) |
| `--formats`, `-f` | comma separated: `json`, `jsonl`, `csv`, `sql`, `ts`, `pytest` (default: all) |
| `--count`, `-n` | rows per table (default: 10) |
| `--seed`, `-s` | seed for the generator (default: derived from the input) |
| `--relations`, `-r` | export the flattened relational tables instead of nested documents (the SQL export is always relational) |

### validate

Checks every `$ref` in the document set and reports the ones that cannot be resolved. Exits with a non-zero status when a reference is broken, which makes it usable as a CI step.

### inspect

Prints the tables, columns, primary keys and foreign keys that the tool derived from the document, without writing any files. Useful to confirm that a schema is read the way you expect before generating.

## How it compares

| Tool | Language | Produces | Needs a running server |
| --- | --- | --- | --- |
| **schemaseed** | Node.js CLI | Seed rows, PostgreSQL DDL and DML, CSV/JSON/JSONL, TypeScript constants, a pytest suite with negative cases | No |
| [json-schema-faker](https://json-schema-faker.js.org/) | JavaScript library | A JSON value matching one JSON Schema, returned from a `generate()` call; also supports a seeded PRNG | No |
| [@faker-js/faker](https://fakerjs.dev) | JavaScript library | Random primitives you compose yourself; it takes no schema as input | No |
| [schemathesis](https://github.com/schemathesis/schemathesis) | Python (on PyPI) | Test cases sent as real HTTP, GraphQL or gRPC requests to a live API, plus a report | Yes |

Schemathesis answers a different question: it finds bugs in a service that is already running. SchemaSeed produces the fixtures you load into a database before the service starts.

## Examples

The `examples/` directory in this package holds two complete runs, one per mode, with the generated files checked in so they can be read and diffed without running anything.

## License

MIT — see [LICENSE](LICENSE).

## Support

support@schemaseed.drz8848.win

## Why it is free, and what sponsorship is for

The CLI above is MIT licensed and complete on its own. There is no feature of it that is
locked behind a paid tier, and there is no plan to add one.

Two things make it possible to keep it that way:

- It runs on your machine. There is no service for us to pay for per request, so there is
  no per-request cost to pass on to you.
- It is the whole product. There is no second edition of it.

If it saved you time, you can support the maintenance of it - bug fixes, new schema
keywords, new output formats, and answering the issues people file. Sponsorship buys
maintenance time, not features: the tool stays free and open source either way.

See <https://schemaseed.drz8848.win/support> for the channels that are open right now.

## Links

- npm: <https://www.npmjs.com/package/@wenlu8848/schemaseed>
- Website: <https://schemaseed.drz8848.win>
- Repository: <https://github.com/drz8848-mike8844/schemaseed>
