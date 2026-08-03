# dbtx

ORM-agnostic test database isolation for Node.js. Every test starts against a
clean database, and you write no `beforeEach`, no test helpers, and no changes
to your application code.

It is designed to work with Prisma 7, Drizzle, Kysely, Knex, TypeORM, Sequelize,
MikroORM and raw SQL — because it hooks the **database driver**, not the ORM.

**v0.1 targets PostgreSQL with the `pg` driver and Vitest.**

> **What is actually verified.** dbtx's own suite exercises `pg` directly,
> through the Vitest plugin, and through **Prisma 7 and Drizzle**, against
> PostgreSQL 14 and 18. The other ORMs on that list are untested in v0.1;
> support for them follows from the same mechanism — they all issue their
> statements through `pg` — but it is reasoning, not a test result.

## Setup

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { dbtx } from 'dbtx/vitest'

export default defineConfig({
  plugins: [
    dbtx({
      url: process.env.DATABASE_URL!,
      strategy: 'transaction', // or 'database'
      migrate: 'npx prisma migrate deploy',
      seed: 'tsx test/seed.ts',
      resetSequences: true,
    }),
  ],
})
```

That is the whole setup. The plugin injects its own `globalSetup` and
`setupFiles`, so your tests need to know nothing about it:

```ts
import { expect, it } from 'vitest'
import { createUser, countUsers } from '../src/db'

it('writes a user', async () => {
  await createUser('alice')
  expect(await countUsers()).toBe(1)
})

it('does not see it', async () => {
  expect(await countUsers()).toBe(0) // clean again
})
```

### Tell dbtx which `pg` you use

Recommended. It removes the one failure that has no symptom — dbtx patching a
different copy of `pg` than your application imports, where every test passes
and nothing is isolated:

```ts
// test/dbtx-driver.ts
import pg from 'pg'
import { useDriver } from 'dbtx'

useDriver(pg)
```

```ts
// vitest.config.ts
test: { setupFiles: ['./test/dbtx-driver.ts'] }
```

Without it, dbtx compares the path it resolves `pg` to against the path your
project resolves. If they differ it fails immediately. If it cannot tell — no
`pg` resolvable from your project root, a bundled setup — it warns, and
`strict: true` turns that warning into an error.

### Prisma

Prisma 7 reaches Postgres through a driver adapter over plain `pg`, so dbtx
isolates it with no Prisma-specific code on either side — including
`prisma.$transaction`, which becomes a savepoint inside the test transaction.

One thing is worth knowing. `new PrismaPg({ connectionString })` builds a pool
of Prisma's own, which under dbtx means a second pinned session that cannot see
uncommitted rows written through your application's pool. Hand it your pool
instead and everything shares one connection and one transaction:

```ts
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { pool } from './db' // your application's pg Pool

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
```

## How it works

When a test is active, dbtx patches `Client.prototype.query` on your `pg`
module. The first statement that needs a transaction gets a `BEGIN` sent ahead
of it on that same connection, and that connection is registered with the test;
a test that only reads never opens a transaction at all. Your ORM's own
`BEGIN`, `COMMIT` and `ROLLBACK` are rewritten into savepoints scoped to the
test, so nested transactions inside your code still behave like transactions.
`Pool.prototype.connect` hands out one pinned connection per pool, because a
transaction lives on a single connection. At the end of the test every
registered connection is rolled back, fully awaited before the next test starts.

Since Prisma 7 connects through driver adapters (`@prisma/adapter-pg` → plain
`pg`), intercepting at the `pg` level covers Prisma and every other ORM at once.

## Strategies

| | `transaction` (default) | `database` |
|---|---|---|
| How it cleans up | rolls back a savepoint | `TRUNCATE ... RESTART IDENTITY CASCADE` |
| Speed | fastest | slower — a real database per worker |
| Commits | never | real |
| DDL in tests | limited (see below) | yes |
| `LISTEN`/`NOTIFY` | no | yes |
| Deferred constraints | not checked | checked |
| `now()` | transaction start time | correct |
| Several connections | one pinned per pool | unrestricted |
| Replays your seed | n/a — nothing is lost | **no** (see caveats) |

The `database` strategy builds a template database once per run, applies your
migrations and seed to it, seals it, and gives each Vitest worker a file-level
clone (`CREATE DATABASE ... TEMPLATE`), which is far cheaper than re-running
migrations per worker.

## When you have to use `strategy: 'database'`

These are not bugs and they are not going to be fixed — they follow from the
test being one open transaction. dbtx raises a clear error for the first two
rather than letting Postgres produce a confusing one.

- **`VACUUM`, `CREATE`/`DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`,
  `CREATE`/`DROP DATABASE`, `ALTER SYSTEM`, `PREPARE TRANSACTION`,
  `DISCARD ALL`** — Postgres refuses to run these inside a transaction block.
  (`DISCARD PLANS`, `SEQUENCES` and `TEMP` are fine and pass straight through.)
- **`COMMIT AND CHAIN` / `ROLLBACK AND CHAIN`** — these open a new transaction
  outside our savepoint stack. Refused in v0.1.
- **`LISTEN` / `NOTIFY`** — notifications are delivered at commit. The test
  transaction never commits, so a test waiting for one waits forever.
- **Deferred constraint checking** — `DEFERRABLE` constraints, `SET CONSTRAINTS
  ALL DEFERRED` and `AFTER ... DEFERRABLE` triggers all fire at commit. Under
  `transaction` they never fire, so **a test expecting a deferred unique or
  foreign-key violation will pass while the code is broken.** This one fails in
  the dangerous direction; if you rely on deferred constraints, use
  `strategy: 'database'`.

## Caveats

**`now()` is frozen.** Inside a transaction `now()` returns the transaction's
start time, so two calls in one test give the same value. This is Postgres
semantics and cannot be fixed from here. Use `statement_timestamp()` or
`clock_timestamp()` where you need the wall clock, or `strategy: 'database'`.

**One connection is pinned per pool.** While a test runs, every
`pool.connect()` and `pool.query()` on a given pool resolves to the same
connection, and its `release()` is a no-op so your ORM cannot end the test
transaction by returning it. Two consequences:

- Code that expects two independent sessions from one pool gets one, and sees
  its own uncommitted writes through what it believes is another connection.
- Code that opens **two pools** gets two pinned sessions, each holding a
  transaction open for the whole test. If one takes a row lock the other wants,
  the second waits for a commit that never comes. In production those
  transactions last milliseconds; here they last the test. Set a
  `statement_timeout` if you want that to surface as an error rather than a
  hang.

**We cannot see inside functions.** `SELECT my_function()` may write, and at
the driver level it is indistinguishable from a read. If such a statement is
your only write, it will not open the test transaction.

**Savepoint names can collide.** dbtx emits savepoints named
`"<prefix>_<pool>_<n>_sp_<depth>"`. If your own code creates a savepoint with
exactly that name, the two will interfere. v0.1 does not defend against this.

**`resetSequences` needs one database per worker, or one worker.** Under
`transaction` all workers share your one database, and sequences are neither
transactional nor per-session, so one worker's reset lands inside another
worker's test. dbtx refuses this combination rather than producing an id that
is right most of the time. Use `strategy: 'database'`, or
`fileParallelism: false`.

**`database` does not replay your seed.** After the first test, whatever the
seed inserted is gone — truncation takes it with everything else. Migration
bookkeeping tables (`_prisma_migrations`, `__drizzle_migrations`,
`knex_migrations`, `typeorm_metadata`, and friends) are never truncated; add
your own with `excludeTables`.

**Extensions must be in your migrations.** Templates are cloned from
`template0`, so anything installed into `template1` by hand is not there. dbtx
does carry over your database's encoding and locale, so text sorts in tests the
way it sorts in production.

**Leftover databases with live connections are not pruned.** dbtx drops stale
`<prefix>_*` databases at the start of a run, but skips any that currently have
connections, since on a shared server those usually belong to a run still in
progress. Postgres does not record when a database was created, so there is no
"older than a day" rule to fall back on.

**v0.1 is PostgreSQL and `pg` only.** MySQL, SQLite, `postgres.js`, `mysql2`,
Jest and `node:test` are not supported.

## Why this exists

Every existing solution covers one corner of the problem:

| Package | Weekly DL | Gap |
|---|---|---|
| `pg-transactional-tests` | ~75k | Explicitly does not work with Prisma. Requires manual hook wiring. |
| `@chax-at/transactional-prisma-testing` | small | Prisma-only. Known issues: savepoint desync, extension conflicts, timeout ignored, rollback race. |
| `pgsql-test` | ~27k | Postgres + raw SQL only, tied to the `pgpm` ecosystem, no ORM awareness. |
| `vitest-environment-prisma-postgres` | ~16k | Locked to Prisma + Postgres + Vitest. |

dbtx hooks the driver instead of the ORM, so one implementation covers all of
them.

## API

```ts
import { dbtx, useDriver } from 'dbtx'

await dbtx.uncommitted(async () => {
  // Outside the isolation: this really commits, and cleaning it up is yours.
  await pool.query('CREATE TABLE scratch (id int)')
})

dbtx.isolated // boolean — are statements being isolated right now
dbtx.depth    // number  — nesting depth of your own transactions, for debugging

useDriver(pg) // tell dbtx which copy of pg to patch
```

### Options

| Option | Default | |
|---|---|---|
| `url` | — | Connection string for your test database. |
| `strategy` | `'transaction'` | `'transaction'` or `'database'`. |
| `migrate` | — | Shell command, run once against the template. |
| `seed` | — | Shell command, run once against the template. |
| `resetSequences` | `false` | Reset every sequence to 1 before each test. |
| `strict` | `false` | Turn "cannot verify the pg module" into an error. |
| `prefix` | `'dbtx'` | Prefix for the databases and savepoints dbtx creates. |
| `maintenanceDatabase` | first of `postgres`, your own database, `template1` | Where admin statements run — never the database being created or dropped. |
| `cacheTemplate` | — | `{ files: [...] }` — reuse the template between runs, keyed on those files' contents. |
| `excludeTables` | `[]` | Extra tables the `database` strategy must not truncate. |
| `keepDatabases` | `false` | Leave dbtx's databases behind for inspection. |

By default the template is rebuilt every run. `cacheTemplate` is opt-in and
keyed on the **contents** of the files you name, because keying it on the
`migrate` command would happily serve a stale schema — `npm run migrate` does
not change when you add a migration.

Set `DBTX_DEBUG=1` for a log of everything dbtx rewrites and every connection
it pins.

## Requirements

Node 20+, PostgreSQL 14+, `pg` 8.7+, Vitest 2+. `pg` and `vitest` are optional
peer dependencies.

CI runs Node 20, 22 and 24 against PostgreSQL 14, 16 and 18. Postgres 13 will
probably work — the only version-dependent path, `DROP DATABASE ... WITH
(FORCE)`, has a fallback below 13 — but it is not covered by CI, so it is not
claimed.

## License

MIT
