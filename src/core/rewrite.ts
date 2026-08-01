import type { TestCtx } from './context.js'
import { log } from './log.js'

/**
 * What a suppressed statement is replaced with. `COMMIT`/`ROLLBACK` at depth 0
 * would end the test transaction itself, so they become a harmless no-op
 * instead (SPEC §3.2).
 */
export const SUPPRESSED = 'SELECT 1'

/** Raised for statements dbtx cannot honour under `strategy: 'transaction'`. */
export class DbtxUnsupportedStatementError extends Error {
  readonly statement: string

  constructor(message: string, statement: string) {
    super(message)
    this.name = 'DbtxUnsupportedStatementError'
    this.statement = statement
  }
}

/*
 * Transaction control, with every Postgres spelling of it. Missing one of
 * these aliases is not cosmetic: an unrewritten COMMIT commits the test
 * transaction itself and isolation is gone.
 *
 * BEGIN side:    BEGIN [WORK|TRANSACTION] [ISOLATION LEVEL ...|READ ONLY|
 *                READ WRITE|[NOT] DEFERRABLE], START TRANSACTION [...]
 * COMMIT side:   COMMIT [WORK|TRANSACTION], END [WORK|TRANSACTION]
 * ROLLBACK side: ROLLBACK [WORK|TRANSACTION], ABORT [WORK|TRANSACTION]
 *
 * `COMMIT PREPARED` / `ROLLBACK PREPARED` are two-phase commit, not the same
 * statement, and pass through. So do the caller's own savepoint statements:
 * `SAVEPOINT x`, `RELEASE [SAVEPOINT] x` and `ROLLBACK TO [SAVEPOINT] x` —
 * note the `SAVEPOINT` keyword is optional in the last two, which is why the
 * ROLLBACK pattern excludes `TO` rather than looking for `TO SAVEPOINT`.
 */
const BEGIN = /^(?:BEGIN|START\s+TRANSACTION)\b/i
const COMMIT = /^(?:COMMIT|END)\b(?!\s+PREPARED\b)/i
const ROLLBACK = /^(?:ROLLBACK|ABORT)\b(?!\s+(?:TO|PREPARED)\b)/i

/**
 * `COMMIT AND CHAIN` / `ROLLBACK AND CHAIN` immediately open a new
 * transaction, which would sit outside our savepoint stack. `AND NO CHAIN` is
 * the default behaviour and is fine.
 */
const AND_CHAIN = /\bAND\s+CHAIN\b/i

/**
 * Statements Postgres refuses to run inside a transaction block. Under
 * `strategy: 'transaction'` the whole test *is* a transaction block, so these
 * cannot work in principle — better a clear error than Postgres's own.
 * `DISCARD` additionally resets the session state we pin (SPEC §3.3).
 */
const CANNOT_RUN_IN_TRANSACTION: ReadonlyArray<readonly [RegExp, string]> = [
  [/^VACUUM\b/i, 'VACUUM'],
  [/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY'],
  [/^DROP\s+INDEX\s+CONCURRENTLY\b/i, 'DROP INDEX CONCURRENTLY'],
  [/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i, 'REINDEX CONCURRENTLY'],
  [/^CREATE\s+DATABASE\b/i, 'CREATE DATABASE'],
  [/^DROP\s+DATABASE\b/i, 'DROP DATABASE'],
  [/^ALTER\s+SYSTEM\b/i, 'ALTER SYSTEM'],
  [/^PREPARE\s+TRANSACTION\b/i, 'PREPARE TRANSACTION'],
  [/^DISCARD\b/i, 'DISCARD'],
]

/**
 * Strip leading comments and surrounding whitespace, and drop trailing
 * semicolons, so the leading keyword can be matched.
 */
function normalize(sql: string): string {
  let s = sql
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*\n?/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    if (s === before) break
  }
  return s.replace(/[\s;]+$/, '')
}

/** Quote a savepoint name for this context: `"<ctxId>_sp_<depth>"`. */
export function savepointName(ctx: TestCtx, depth: number): string {
  return `"${ctx.id.replace(/"/g, '""')}_sp_${depth}"`
}

/**
 * Reject what we cannot honour, loudly. Called for every statement while a
 * test is active, so a silent wrong answer is never the outcome.
 */
export function assertSupported(sql: string): void {
  const stmt = normalize(sql)
  if (stmt === '') return

  if (AND_CHAIN.test(stmt) && (COMMIT.test(stmt) || ROLLBACK.test(stmt))) {
    throw new DbtxUnsupportedStatementError(
      'dbtx: AND CHAIN is not supported. It opens a new transaction immediately, ' +
        "outside the test's savepoint stack, so isolation could not be guaranteed. " +
        `Statement: ${JSON.stringify(stmt)}`,
      stmt,
    )
  }

  for (const [pattern, name] of CANNOT_RUN_IN_TRANSACTION) {
    if (!pattern.test(stmt)) continue
    const extra =
      name === 'DISCARD'
        ? ' It also resets the session state dbtx pins to keep the test transaction alive.'
        : ''
    throw new DbtxUnsupportedStatementError(
      `dbtx: ${name} cannot run inside a transaction block, and under ` +
        `strategy: 'transaction' the whole test is one.${extra} Use strategy: 'database' ` +
        `for this test file, or run the statement outside the test. ` +
        `Statement: ${JSON.stringify(stmt)}`,
      stmt,
    )
  }
}

/**
 * Rewrite the ORM's own transaction control into savepoints scoped to `ctx`
 * (SPEC §3.2). Mutates `ctx.depth`. Any other statement is returned untouched.
 *
 * Throws for statements that cannot work under this strategy — see
 * {@link assertSupported}.
 *
 * Call this before `needsTransaction()`: the two compose, so a `BEGIN` becomes
 * a `SAVEPOINT` (which does need a transaction) and a depth-0 `COMMIT` becomes
 * `SELECT 1` (which does not).
 */
export function rewrite(sql: string, ctx: TestCtx): string {
  const stmt = normalize(sql)
  if (stmt === '') return sql
  // A multi-statement string such as `BEGIN; INSERT ...` must pass through
  // whole: rewriting it on its leading keyword would throw the rest away.
  if (stmt.includes(';')) return sql

  assertSupported(stmt)

  if (BEGIN.test(stmt)) {
    const name = savepointName(ctx, ++ctx.depth)
    log('rewrite', JSON.stringify(stmt), '->', `SAVEPOINT ${name}`)
    return `SAVEPOINT ${name}`
  }

  if (COMMIT.test(stmt)) {
    if (ctx.depth === 0) {
      log('rewrite', JSON.stringify(stmt), '-> suppressed (depth 0)')
      return SUPPRESSED
    }
    const name = savepointName(ctx, ctx.depth--)
    log('rewrite', JSON.stringify(stmt), '->', `RELEASE SAVEPOINT ${name}`)
    return `RELEASE SAVEPOINT ${name}`
  }

  if (ROLLBACK.test(stmt)) {
    if (ctx.depth === 0) {
      log('rewrite', JSON.stringify(stmt), '-> suppressed (depth 0)')
      return SUPPRESSED
    }
    const name = savepointName(ctx, ctx.depth--)
    log('rewrite', JSON.stringify(stmt), '->', `ROLLBACK TO SAVEPOINT ${name}`)
    return `ROLLBACK TO SAVEPOINT ${name}`
  }

  return sql
}

/** Row locking makes a `SELECT` transactional even though it writes nothing. */
const LOCKING = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i
/** `SELECT ... INTO` creates a table. */
const SELECT_INTO = /\bINTO\b/i
/** A CTE is only a read if nothing inside it modifies data. */
const DATA_MODIFYING = /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i

/**
 * Everything after `EXPLAIN` that is still an option rather than the statement
 * being explained: either a parenthesised option list — `EXPLAIN (ANALYZE)`,
 * `EXPLAIN (BUFFERS, ANALYZE)`, `EXPLAIN (ANALYZE true, BUFFERS)` — or the
 * bare `ANALYZE`/`VERBOSE` keywords.
 */
function explainOptions(rest: string): string {
  const trimmed = rest.trimStart()
  if (trimmed.startsWith('(')) {
    const end = trimmed.indexOf(')')
    return end === -1 ? trimmed : trimmed.slice(0, end + 1)
  }
  const bare = /^(?:(?:ANALY[SZ]E|VERBOSE)\s*)+/i.exec(trimmed)
  return bare?.[0] ?? ''
}

/**
 * Whether this statement must run inside the test transaction, i.e. whether a
 * lazy `BEGIN` has to be sent first (SPEC §3.1).
 *
 * The default answer is true, so anything unrecognised is treated as a write
 * rather than silently escaping isolation. Only `SELECT`, `SHOW`, read-only
 * CTEs and non-executing `EXPLAIN` are exempt.
 *
 * Known hole, documented rather than hidden: `SELECT my_function()` may write
 * inside the function body and is indistinguishable from a read at this level.
 */
export function needsTransaction(sql: string): boolean {
  const stmt = normalize(sql)
  if (stmt === '') return false
  // `SELECT 1; INSERT ...` leads with a read but is not one, so a
  // multi-statement string falls back to the safe answer.
  if (stmt.includes(';')) return true

  const head = /^[A-Za-z]+/.exec(stmt)?.[0].toUpperCase() ?? ''
  switch (head) {
    case 'SHOW':
      return false
    case 'SELECT':
      return LOCKING.test(stmt) || SELECT_INTO.test(stmt)
    case 'WITH':
      return DATA_MODIFYING.test(stmt) || LOCKING.test(stmt)
    case 'EXPLAIN': {
      const rest = stmt.slice('EXPLAIN'.length)
      return /\bANALY[SZ]E\b/i.test(explainOptions(rest))
    }
    default:
      // INSERT, UPDATE, DELETE, MERGE, CALL, COPY, TRUNCATE, REFRESH
      // MATERIALIZED VIEW, CREATE TABLE AS and every DDL statement land here.
      return true
  }
}
