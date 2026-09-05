# @better-trigger/testing

Private, source-only test and acceptance helpers. `runScenario` provisions a
scratch PostgreSQL database, runs checks and LIFO teardown, then exits with a
nonzero verdict for any body, check, or cleanup failure.

## Database ownership

`resetDb({ name, envVar?, migrate? })` creates a new database on every call.
`name` and an optional environment override such as `BT_CRASH_DB` are **logical
prefixes**, never literal databases to reset. Existing databases with those
names are untouched. Parallel calls, suites, and processes get distinct names.

Prefixes must match `[A-Za-z_][A-Za-z0-9_]*`; invalid prefixes fail before opening
a pool. The prefix is lowercased and truncated to 30 ASCII bytes, followed by
`_` and a random 32-hex suffix. The actual name fits
[PostgreSQL's 63-byte identifier limit](https://www.postgresql.org/docs/16/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS);
quoted SQL, `db.name`, and the pathname in `db.url` all use this same name. Always
connect through the returned URL, rather than reconstructing a name from env.

`DATABASE_URL` supplies credentials, host, port, and connection parameters;
its database pathname is replaced for both the `postgres` admin pool and the
new instance. Queries (including `sslmode`, `ssl`, certificate paths, and
application settings) are retained and interpreted by the
[installed pg driver](https://node-postgres.com/features/ssl).
Fragments are removed. `databaseUrlFor(name, raw?)` replaces the pathname;
`baseUrl(raw?)` retains the query, so appending `/${name}` to it is incorrect.
Production pool/TLS defaults are unchanged.

```ts
import { resetDb } from '@better-trigger/testing';

const db = await resetDb({ name: 'my_suite' }); // migrates unless migrate: false
try {
  await db.pool.query('SELECT 1');
} finally {
  await db.drop();
}
```

The handle owns only its successfully created instance. Failed CREATE calls
never trigger DROP, including collisions. If setup or migration fails after
CREATE, cleanup attempts to close the target pool and drop that instance.
Cleanup uses the server settings captured at creation, even if env changes.

`end()` closes the pool without dropping the database. `drop()` closes it and
then attempts DROP even when closing fails. Both methods share the first
operation's promise across concurrent or repeated calls: success is idempotent,
and failure remains a rejection, not a later false success. They do not retry.
When multiple operations fail, `AggregateError.errors` retains their diagnostics;
setup failure stays the `cause` and first error. A rejected cleanup may require
manual inspection using the actual database name. Abrupt process termination
or a lost CREATE acknowledgement can leave an instance behind; the helper does
not guess ownership from a prefix or sweep other databases.

## Scenarios and inspection

`runScenario` drops its database by default after every registered cleanup,
whether the body passed or failed. Register daemon shutdown and client release
with `s.cleanup()` so they finish before database cleanup. A failed pool close
or DROP contributes to the scenario's failed verdict.

For debugging, pass `keepDatabase: true` in scenario metadata, or set
`BT_KEEP_TEST_DATABASE=1`. Explicit metadata takes precedence over the env var.
The pool still closes, and output explicitly says `database retained (not
dropped)` with the actual name; remove that instance manually when finished.
This option applies after successful provisioning, not to failed migrations.
Logs identify only host, port, and actual database name, omitting credentials,
queries, and fragments.

```sh
BT_KEEP_TEST_DATABASE=1 bun run --filter @better-trigger/example-basic e2e
```

## Verification

`bun run --cwd packages/testing test` runs lifecycle/error-injection tests without
Postgres. With an explicit `DATABASE_URL`, it also runs real PostgreSQL probes:
concurrent calls with long uppercase prefixes and two copies of one scenario in
separate Bun processes. The latter holds both connections open, releases one,
checks its database is gone while its peer and a pre-existing prefix database
survive, then verifies the second scenario leaves no instance behind.
