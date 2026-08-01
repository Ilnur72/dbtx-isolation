import type { TestCtx } from './context.js'
import { log } from './log.js'

/**
 * What a suppressed statement is replaced with. `COMMIT`/`ROLLBACK` at depth 0
 * would end the test transaction itself, so they become a harmless no-op
 * instead (SPEC §3.2).
 */
export const SUPPRESSED = 'SELECT 1'

/** Statements that never need a transaction of their own (SPEC §7.7). */
const READ_ONLY = /^(?:SELECT|SHOW|EXPLAIN)\b/i

const BEGIN = /^(?:BEGIN|START\s+TRANSACTION)\b/i
// `END [WORK|TRANSACTION]` is a Postgres alias for COMMIT; if it were passed
// through it would commit the whole test transaction. `COMMIT PREPARED` is a
// different, two-phase statement and is left alone.
const COMMIT = /^(?:COMMIT|END)\b(?!\s+PREPARED\b)/i
// A bare rollback only. `ROLLBACK TO [SAVEPOINT] x` and `ROLLBACK PREPARED x`
// are the caller's own savepoint handling and must pass through untouched.
const ROLLBACK = /^ROLLBACK\b(?!\s+(?:TO|PREPARED)\b)/i

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

/** Quote a savepoint name for this context: `"<ctxId>_<n>"`. */
export function savepointName(ctx: TestCtx, depth: number): string {
  return `"${ctx.id.replace(/"/g, '""')}_${depth}"`
}

/**
 * Rewrite the ORM's own transaction control into savepoints scoped to `ctx`
 * (SPEC §3.2). Mutates `ctx.depth`. Any other statement is returned untouched.
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

/**
 * Everything after `EXPLAIN` that is still an option rather than the statement
 * being explained: either a parenthesised option list or the bare
 * `ANALYZE`/`VERBOSE` keywords.
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
 * False for `SELECT` / `SHOW` / `EXPLAIN`; true for anything else, so an
 * unrecognised statement is treated as a write rather than silently escaping
 * isolation. `EXPLAIN ANALYZE` really executes its inner statement, so it
 * counts as a write.
 */
export function needsTransaction(sql: string): boolean {
  const stmt = normalize(sql)
  if (stmt === '') return false
  // `SELECT 1; INSERT ...` leads with a read but is not one, so a
  // multi-statement string falls back to the safe answer.
  if (stmt.includes(';')) return true
  if (!READ_ONLY.test(stmt)) return true

  const explain = /^EXPLAIN\b/i.exec(stmt)
  if (explain !== null) {
    return /\bANALY[SZ]E\b/i.test(explainOptions(stmt.slice(explain[0].length)))
  }
  return false
}
