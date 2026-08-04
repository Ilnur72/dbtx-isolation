# dbtx — Build Specification

> This is the single source of truth for building this package.
> Read it fully before writing any code. Ask before deviating from
> any decision marked **NON-NEGOTIABLE**.

## 1. What we are building

`dbtx` (published on npm as `dbtx-isolation`) — an **ORM-agnostic test database
isolation library for Node.js**.

Every test starts against a clean database. The developer writes zero
boilerplate: no `beforeEach`, no test helpers, no changes to application code.

It works with Prisma 7, Drizzle, Kysely, Knex, TypeORM, Sequelize, MikroORM and
raw SQL — because it hooks the **database driver**, not the ORM.

Target for v0.1: **PostgreSQL + `pg` driver + Vitest.**

## 2. Why this exists (market context)

Existing solutions each cover only one corner of the problem:

| Package | Weekly DL | Gap |
|---|---|---|
| `pg-transactional-tests` | ~75k | Explicitly does not work with Prisma. Requires manual hook wiring. |
| `@chax-at/transactional-prisma-testing` | small | Prisma-only. Known issues: savepoint desync, extension conflicts, timeout ignored, rollback race. |
| `pgsql-test` | ~27k | Postgres + raw SQL only, tied to the `pgpm` ecosystem, no ORM awareness. |
| `vitest-environment-prisma-postgres` | ~16k | Locked to Prisma + Postgres + Vitest. |

**Our wedge:** since Prisma 7 connects through driver adapters
(`@prisma/adapter-pg` → plain `pg`), intercepting at the `pg` level now covers
Prisma *and* every other ORM at once. Nobody has exploited this yet.

Do not lose this positioning. The README must make it obvious.

## 3. Non-negotiable technical decisions

These were derived from studying how the competitors fail. Do not "simplify"
them away.

### 3.1 Lazy BEGIN — **NON-NEGOTIABLE**

We must **not** open the test transaction ourselves on our own pool. The
application creates its own `Pool`; a transaction we start on a different pool
would never wrap the app's queries.

Instead: patch `Client.prototype.query`. When a test is active and the incoming
SQL is a **write** (not `SELECT` / `SHOW` / `EXPLAIN`) and this client has not
begun yet, send `BEGIN` on *that* client first, mark it, and register it in the
test context. Roll back every registered client in `afterEach`.

Consequence: a test that only reads never opens a transaction. This is intended.

### 3.2 Savepoint rewriting — **NON-NEGOTIABLE**

Inside an active test, rewrite the ORM's own transaction statements:

- `BEGIN` / `START TRANSACTION` → `SAVEPOINT "<ctxId>_<++depth>"`
- `COMMIT` → `RELEASE SAVEPOINT "<ctxId>_<depth-->"`
- bare `ROLLBACK` → `ROLLBACK TO SAVEPOINT "<ctxId>_<depth-->"`
- at `depth === 0`, `COMMIT` and `ROLLBACK` become `SELECT 1` (suppressed)
- **never** touch an explicit `ROLLBACK TO SAVEPOINT ...` or `RELEASE SAVEPOINT ...`

Savepoint names are prefixed per test context. This is what prevents the
`savepoint ... does not exist` class of bug seen in `@chax-at`.

### 3.3 Pinned connection per pool — **NON-NEGOTIABLE**

A transaction lives on one connection. Patch `Pool.prototype.connect` so that,
while a test is active, every call resolves to the **same** client for that pool
(cache it in a `WeakMap` keyed by pool). Replace that client's `release()` with
a no-op so the ORM returning it to the pool does not break the transaction.
Save the original in a symbol and restore it on rollback and on `Pool.end()`.

Document the known consequence: if user code opens a transaction but then
queries through the pool handle instead of the transaction handle, the test
hangs. That is a genuine bug in their code and we surface it.

### 3.4 Context tracking via AsyncLocalStorage — **NON-NEGOTIABLE**

Use `AsyncLocalStorage` for the per-test context, plus a module-level
`ambient` fallback, because Vitest's `beforeEach`/`afterEach` hooks run outside
the ALS chain. A global counter alone is not safe under parallelism.

The context carries: `id`, `depth`, `active`, `bypass`, `clients: Set`.

### 3.5 `VITEST_POOL_ID`, not `VITEST_WORKER_ID` — **NON-NEGOTIABLE**

For per-worker databases use `process.env.VITEST_POOL_ID` — it is bounded
between 1 and `maxWorkers`. `VITEST_WORKER_ID` increments without bound and
would create one database per test file. This is verified against Vitest source
(`packages/vitest/src/runtime/workers/init.ts`).

### 3.6 Template database cloning

Create the template once in `globalSetup` (before workers exist):
`CREATE DATABASE <t> TEMPLATE template0`, run `migrate` and `seed` against it via
`DATABASE_URL`, then `ALTER DATABASE <t> WITH is_template = true ALLOW_CONNECTIONS false`.

Each worker clones it: `CREATE DATABASE <w> TEMPLATE <t>`. In Postgres this is a
file-level copy — far cheaper than re-running migrations.

Always use `DROP DATABASE IF EXISTS ... WITH (FORCE)`. Admin statements run on
the `postgres` database, never on the target.

Also ship `pruneOrphans()` to drop leftover `dbtx_*` databases from crashed CI
runs, and call it at the start of `globalSetup`.

### 3.7 Exempt maintenance connections

Sequence resets and truncation must not be rewritten or wrapped. Mark such
clients with a `Symbol.for('dbtx.exempt')` flag and skip them in the patch.

### 3.8 Await the rollback

`afterEach` must fully `await` the rollback of every registered client before
returning. A fire-and-forget rollback is the root of the flakiness reported
against `@chax-at`.

## 4. Public API

```ts
// vitest.config.ts
import { dbtx } from 'dbtx-isolation/vitest'

export default defineConfig({
  plugins: [dbtx({
    url: process.env.DATABASE_URL!,
    strategy: 'transaction',      // | 'database'
    migrate: 'npx prisma migrate deploy',
    seed: 'tsx test/seed.ts',
    resetSequences: true,
  })],
})
```

```ts
import { dbtx } from 'dbtx-isolation'

dbtx.uncommitted(fn)   // escape the isolation (DDL, LISTEN/NOTIFY)
dbtx.isolated          // boolean
dbtx.depth             // number, for debugging
```

The plugin injects `globalSetup` + `setupFiles` and passes config through
Vitest's `provide` / `inject`. The user writes no hooks.

## 5. Strategies

`transaction` (default): savepoint rollback per test. Fastest.

`database`: real commits; after each test `TRUNCATE ... RESTART IDENTITY CASCADE`
on all user tables, excluding migration bookkeeping tables
(`_prisma%`, `__drizzle_migrations`, `knex_migrations`, `migrations`,
`typeorm_metadata`). Slower, but supports DDL, `LISTEN`/`NOTIFY`, multiple
connections and correct `now()` semantics.

In v0.1 `database` does **not** replay the seed after truncation. Say so plainly
in the README rather than pretending otherwise.

## 6. File tree

```
src/
  index.ts                     public API + re-exports
  types.ts                     DbtxConfig, Strategy, Strategyish
  admin.ts                     createTemplate, dropTemplate, cloneDatabase, pruneOrphans, withDb
  core/log.ts                  DBTX_DEBUG gated logger
  core/context.ts              TestCtx, ALS, newCtx, withBypass
  core/rewrite.ts              rewrite(), needsTransaction()
  drivers/pg.ts                patchPg(), exempt(), rollbackClient()
  drivers/index.ts             patchDetectedDrivers()
  strategies/transaction.ts
  strategies/database.ts
  strategies/index.ts          makeStrategy()
  runners/vitest.ts            Vite plugin
  runners/vitest-global-setup.ts
  runners/vitest-setup.ts
test/
  schema.sql  helpers.ts  rewrite.test.ts  isolation.test.ts
.github/workflows/ci.yml
```

`package.json`: `"type": "module"`, subpath exports for `.`, `./vitest`,
`./vitest/global-setup`, `./vitest/setup`. `pg` and `vitest` are **optional peer
dependencies**. Node >= 20. TypeScript strict, `NodeNext` module resolution.

## 7. Acceptance criteria

Unit tests (no database required) for `rewrite`:

1. `BEGIN` and `START TRANSACTION` produce savepoints and increment depth.
2. `COMMIT` produces `RELEASE SAVEPOINT` and decrements depth.
3. bare `ROLLBACK` produces `ROLLBACK TO SAVEPOINT`.
4. at depth 0, `COMMIT` / `ROLLBACK` are suppressed and depth stays 0.
5. an explicit `ROLLBACK TO SAVEPOINT "x"` passes through unchanged.
6. ordinary statements pass through unchanged.
7. `needsTransaction` is false for `SELECT` / `SHOW` / `EXPLAIN`, true for writes.

Integration tests (real Postgres):

8. a row inserted in test A is not visible in test B.
9. with `resetSequences`, and each worker on its own database, the first
   inserted row has `id = 1` in every test. Sequences are neither
   transactional nor per-session, so this cannot hold when several workers
   share one database; dbtx refuses that combination.
10. an ORM-style `BEGIN` … `COMMIT` inside a test is visible within that test
    and gone afterwards.
11. a nested `BEGIN` … `ROLLBACK` discards only the inner work.
12. a SELECT-only test leaves `dbtx.depth === 0` and opens no transaction.
13. `dbtx.uncommitted()` restores the previous bypass state afterwards.

CI matrix: Node 20/22/24 × Postgres 14/16/18, using a `postgres` service
container with a `pg_isready` health check.

## 8. Build order

Work in this sequence, committing after each step, running `npm run typecheck`
as you go:

1. scaffolding: `package.json`, both tsconfigs, `vitest.config.ts`, `.gitignore`
2. `types.ts`, `core/log.ts`, `core/context.ts`, `core/rewrite.ts`
3. `test/rewrite.test.ts` — must pass with no database
4. `drivers/pg.ts`, `drivers/index.ts`
5. `admin.ts`
6. `strategies/*`
7. `runners/*`
8. `test/schema.sql`, `test/helpers.ts`, `test/isolation.test.ts`
9. `.github/workflows/ci.yml`
10. `README.md` with the comparison table and an honest Caveats section
11. `LICENSE` (MIT)

## 9. README requirements

Must contain: the one-block setup example, a "How it works" paragraph, the
strategy comparison table, the competitor comparison table from §2, and a
**Caveats** section stating plainly that under `transaction` the value of
`now()` is the transaction start time (Postgres semantics, unfixable — suggest
`statement_timestamp()` or `strategy: 'database'`), that one connection is
pinned per pool, and that v0.1 is Postgres-only.

Never claim to have solved something we have not.

## 10. Out of scope for v0.1

MySQL, SQLite, `postgres.js`, `mysql2`, Jest, `node:test`, MongoDB, RLS/role
context, seed replay under the `database` strategy. Do not start these.`