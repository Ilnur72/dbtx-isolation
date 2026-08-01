import { describe, expect, it } from 'vitest'
import { newCtx, nextCtxId } from '../src/core/context.js'
import {
  DbtxUnsupportedStatementError,
  needsTransaction,
  rewrite,
  SUPPRESSED,
} from '../src/core/rewrite.js'
import { assertValidPrefix, resolveConfig } from '../src/types.js'

// SPEC §7, criteria 1-7. These must pass with no database available.

const ctx = (): ReturnType<typeof newCtx> => newCtx('t1')

describe('criterion 1 — BEGIN and START TRANSACTION produce savepoints', () => {
  it('rewrites BEGIN and increments depth', () => {
    const c = ctx()
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_sp_1"')
    expect(c.depth).toBe(1)
  })

  it('rewrites START TRANSACTION and increments depth', () => {
    const c = ctx()
    expect(rewrite('START TRANSACTION', c)).toBe('SAVEPOINT "t1_sp_1"')
    expect(c.depth).toBe(1)
  })

  it('numbers nested savepoints by depth', () => {
    const c = ctx()
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_sp_1"')
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_sp_2"')
    expect(rewrite('START TRANSACTION', c)).toBe('SAVEPOINT "t1_sp_3"')
    expect(c.depth).toBe(3)
  })

  it('accepts the syntactic variants ORMs emit', () => {
    for (const sql of [
      'begin',
      'BEGIN;',
      '  BEGIN  ',
      'BEGIN WORK',
      'BEGIN TRANSACTION',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE',
      'START TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'start  transaction',
      '-- prisma\nBEGIN',
      '/* trace-id */ BEGIN',
    ]) {
      const c = ctx()
      expect(rewrite(sql, c), sql).toBe('SAVEPOINT "t1_sp_1"')
      expect(c.depth, sql).toBe(1)
    }
  })

  it('prefixes savepoint names per context so parallel tests cannot collide', () => {
    const a = newCtx('ctx_a')
    const b = newCtx('ctx_b')
    expect(rewrite('BEGIN', a)).toBe('SAVEPOINT "ctx_a_sp_1"')
    expect(rewrite('BEGIN', b)).toBe('SAVEPOINT "ctx_b_sp_1"')
  })
})

describe('criterion 2 — COMMIT releases the savepoint and decrements depth', () => {
  it('releases the savepoint at the current depth', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_sp_1"')
    expect(c.depth).toBe(0)
  })

  it('unwinds nested transactions in order', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    rewrite('BEGIN', c)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_sp_2"')
    expect(c.depth).toBe(1)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_sp_1"')
    expect(c.depth).toBe(0)
  })

  it('accepts the syntactic variants ORMs emit, including every END alias', () => {
    for (const sql of [
      'commit',
      'COMMIT;',
      ' COMMIT ',
      'COMMIT WORK',
      'COMMIT TRANSACTION',
      'END',
      'end',
      'END WORK',
      'END TRANSACTION',
      'COMMIT AND NO CHAIN',
    ]) {
      const c = ctx()
      rewrite('BEGIN', c)
      expect(rewrite(sql, c), sql).toBe('RELEASE SAVEPOINT "t1_sp_1"')
      expect(c.depth, sql).toBe(0)
    }
  })
})

describe('criterion 3 — bare ROLLBACK rolls back to the savepoint', () => {
  it('rolls back to the savepoint at the current depth', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('ROLLBACK', c)).toBe('ROLLBACK TO SAVEPOINT "t1_sp_1"')
    expect(c.depth).toBe(0)
  })

  it('discards only the inner level when nested', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    rewrite('BEGIN', c)
    expect(rewrite('ROLLBACK', c)).toBe('ROLLBACK TO SAVEPOINT "t1_sp_2"')
    expect(c.depth).toBe(1)
  })

  it('accepts the syntactic variants ORMs emit, including every ABORT alias', () => {
    for (const sql of [
      'rollback',
      'ROLLBACK;',
      ' ROLLBACK ',
      'ROLLBACK WORK',
      'ROLLBACK TRANSACTION',
      'ABORT',
      'abort',
      'ABORT WORK',
      'ABORT TRANSACTION',
      'ROLLBACK AND NO CHAIN',
    ]) {
      const c = ctx()
      rewrite('BEGIN', c)
      expect(rewrite(sql, c), sql).toBe('ROLLBACK TO SAVEPOINT "t1_sp_1"')
      expect(c.depth, sql).toBe(0)
    }
  })
})

describe('criterion 4 — at depth 0, COMMIT and ROLLBACK are suppressed', () => {
  it('suppresses COMMIT and leaves depth at 0', () => {
    const c = ctx()
    expect(rewrite('COMMIT', c)).toBe(SUPPRESSED)
    expect(c.depth).toBe(0)
  })

  it('suppresses ROLLBACK and leaves depth at 0', () => {
    const c = ctx()
    expect(rewrite('ROLLBACK', c)).toBe(SUPPRESSED)
    expect(c.depth).toBe(0)
  })

  it('never drives depth negative under repeated commits', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    rewrite('COMMIT', c)
    rewrite('COMMIT', c)
    rewrite('ROLLBACK', c)
    expect(c.depth).toBe(0)
  })

  it('suppresses the END and ABORT aliases too', () => {
    for (const sql of ['END', 'END TRANSACTION', 'ABORT', 'ABORT WORK']) {
      const c = ctx()
      expect(rewrite(sql, c), sql).toBe(SUPPRESSED)
      expect(c.depth, sql).toBe(0)
    }
  })
})

describe('criterion 5 — explicit savepoint statements pass through', () => {
  it('leaves ROLLBACK TO SAVEPOINT alone', () => {
    const c = ctx()
    c.depth = 2
    expect(rewrite('ROLLBACK TO SAVEPOINT "x"', c)).toBe('ROLLBACK TO SAVEPOINT "x"')
    expect(c.depth).toBe(2)
  })

  it('leaves the SAVEPOINT-less form of ROLLBACK TO alone', () => {
    const c = ctx()
    c.depth = 2
    expect(rewrite('ROLLBACK TO x', c)).toBe('ROLLBACK TO x')
    expect(c.depth).toBe(2)
  })

  it('leaves RELEASE SAVEPOINT and SAVEPOINT alone', () => {
    const c = ctx()
    c.depth = 2
    expect(rewrite('RELEASE SAVEPOINT "x"', c)).toBe('RELEASE SAVEPOINT "x"')
    expect(rewrite('RELEASE x', c)).toBe('RELEASE x')
    expect(rewrite('SAVEPOINT "x"', c)).toBe('SAVEPOINT "x"')
    expect(c.depth).toBe(2)
  })

  it('leaves two-phase commit statements alone', () => {
    const c = ctx()
    c.depth = 1
    expect(rewrite("COMMIT PREPARED 'tx1'", c)).toBe("COMMIT PREPARED 'tx1'")
    expect(rewrite("ROLLBACK PREPARED 'tx1'", c)).toBe("ROLLBACK PREPARED 'tx1'")
    expect(c.depth).toBe(1)
  })
})

describe('criterion 6 — ordinary statements pass through unchanged', () => {
  it('returns the input verbatim, formatting and all', () => {
    const c = ctx()
    for (const sql of [
      'SELECT * FROM users WHERE id = $1',
      'INSERT INTO users (name) VALUES ($1) RETURNING *',
      'UPDATE users SET name = $1 WHERE id = $2',
      'DELETE FROM users',
      'WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved',
      'CREATE TABLE t (id int)',
      '  SELECT 1;  ',
      "SELECT 'BEGIN'",
      'SELECT * FROM begin_log',
      'BEGIN; INSERT INTO users (name) VALUES ($1)',
      '',
    ]) {
      expect(rewrite(sql, c), sql).toBe(sql)
    }
    expect(c.depth).toBe(0)
  })
})

describe('criterion 7 — needsTransaction', () => {
  it('is false for SELECT, SHOW and EXPLAIN', () => {
    for (const sql of [
      'SELECT 1',
      'select * from users',
      '  SELECT 1;',
      '-- comment\nSELECT 1',
      '/* comment */ SELECT 1',
      'SHOW search_path',
      'SHOW ALL',
      'EXPLAIN SELECT * FROM users',
      'EXPLAIN (COSTS FALSE) SELECT * FROM users',
      'EXPLAIN VERBOSE SELECT 1',
      SUPPRESSED,
    ]) {
      expect(needsTransaction(sql), sql).toBe(false)
    }
  })

  it('is true for writes', () => {
    for (const sql of [
      'INSERT INTO users (name) VALUES ($1)',
      'update users set name = $1',
      'DELETE FROM users',
      'TRUNCATE users',
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN c int',
      'DROP TABLE t',
      'WITH x AS (INSERT INTO a DEFAULT VALUES RETURNING id) SELECT * FROM x',
      'CALL do_something()',
      'MERGE INTO a USING b ON a.id = b.id WHEN MATCHED THEN DELETE',
    ]) {
      expect(needsTransaction(sql), sql).toBe(true)
    }
  })

  it('treats EXPLAIN ANALYZE as a write, in every spelling', () => {
    for (const sql of [
      'EXPLAIN ANALYZE INSERT INTO users DEFAULT VALUES',
      'EXPLAIN (ANALYZE) INSERT INTO users DEFAULT VALUES',
      'EXPLAIN (ANALYZE, BUFFERS) INSERT INTO users DEFAULT VALUES',
      'EXPLAIN (BUFFERS, ANALYZE) INSERT INTO users DEFAULT VALUES',
      'EXPLAIN (ANALYZE true, BUFFERS) INSERT INTO users DEFAULT VALUES',
      'explain analyse insert into users default values',
    ]) {
      expect(needsTransaction(sql), sql).toBe(true)
    }
  })

  it('is true for the writes that hide behind a read-looking keyword', () => {
    for (const sql of [
      'SELECT * INTO archive FROM users',
      'SELECT * FROM users FOR UPDATE',
      'SELECT * FROM users FOR NO KEY UPDATE',
      'SELECT * FROM users FOR SHARE',
      'SELECT * FROM users FOR KEY SHARE',
      'WITH x AS (UPDATE users SET n = 1 RETURNING *) SELECT * FROM x',
      'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
      'CREATE TABLE archive AS SELECT * FROM users',
      'CALL do_something()',
      'REFRESH MATERIALIZED VIEW mv',
      "COPY users FROM '/tmp/users.csv'",
      'MERGE INTO a USING b ON a.id = b.id WHEN MATCHED THEN DELETE',
    ]) {
      expect(needsTransaction(sql), sql).toBe(true)
    }
  })

  it('leaves a read-only CTE alone', () => {
    expect(needsTransaction('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false)
  })

  it('is true for multi-statement strings that merely lead with a read', () => {
    expect(needsTransaction('SELECT 1; INSERT INTO users DEFAULT VALUES')).toBe(true)
  })

  it('composes with rewrite: a rewritten BEGIN needs the transaction, a suppressed COMMIT does not', () => {
    const c = ctx()
    // BEGIN -> SAVEPOINT, which only works inside a transaction.
    expect(needsTransaction(rewrite('BEGIN', c))).toBe(true)
    // COMMIT at depth 1 -> RELEASE SAVEPOINT; the client is already inside the
    // test transaction by then, so answering true costs nothing.
    expect(needsTransaction(rewrite('COMMIT', c))).toBe(true)
    // COMMIT at depth 0 -> SELECT 1, which must not open a transaction.
    expect(needsTransaction(rewrite('COMMIT', c))).toBe(false)
    expect(needsTransaction(rewrite('ROLLBACK', c))).toBe(false)
  })
})

describe('statements dbtx refuses rather than mishandling', () => {
  it('rejects AND CHAIN, which would open a transaction outside our savepoints', () => {
    for (const sql of ['COMMIT AND CHAIN', 'ROLLBACK AND CHAIN', 'commit and chain']) {
      const c = ctx()
      expect(() => rewrite(sql, c), sql).toThrow(DbtxUnsupportedStatementError)
      expect(() => rewrite(sql, c), sql).toThrow('dbtx: AND CHAIN is not supported')
      expect(c.depth, sql).toBe(0)
    }
  })

  it('allows AND NO CHAIN, which is just the default behaviour', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('COMMIT AND NO CHAIN', c)).toBe('RELEASE SAVEPOINT "t1_sp_1"')
  })

  it('rejects statements Postgres cannot run inside a transaction block', () => {
    for (const sql of [
      'VACUUM',
      'VACUUM FULL users',
      'CREATE INDEX CONCURRENTLY idx ON users (id)',
      'CREATE UNIQUE INDEX CONCURRENTLY idx ON users (id)',
      'DROP INDEX CONCURRENTLY idx',
      'REINDEX INDEX CONCURRENTLY idx',
      'CREATE DATABASE other',
      'DROP DATABASE other',
      'ALTER SYSTEM SET work_mem = 64',
      "PREPARE TRANSACTION 'tx1'",
      'DISCARD ALL',
      'discard all',
      'DISCARD PLANS',
    ]) {
      expect(() => rewrite(sql, ctx()), sql).toThrow(DbtxUnsupportedStatementError)
    }
  })

  it("points at strategy: 'database' instead of just failing", () => {
    expect(() => rewrite('VACUUM', ctx())).toThrow(/strategy: 'database'/)
  })

  it('says why DISCARD in particular is refused', () => {
    expect(() => rewrite('DISCARD ALL', ctx())).toThrow(/session state dbtx pins/)
  })

  it('does not mistake ordinary DDL for the concurrent forms', () => {
    const c = ctx()
    expect(rewrite('CREATE INDEX idx ON users (id)', c)).toBe('CREATE INDEX idx ON users (id)')
    expect(rewrite('REINDEX INDEX idx', c)).toBe('REINDEX INDEX idx')
    expect(rewrite('PREPARE stmt AS SELECT 1', c)).toBe('PREPARE stmt AS SELECT 1')
  })
})

describe('prefix validation', () => {
  it('accepts identifier-safe prefixes', () => {
    for (const prefix of ['dbtx', 'a', '_x', 'my_app_tests', 'a'.repeat(21)]) {
      expect(() => assertValidPrefix(prefix), prefix).not.toThrow()
    }
  })

  it('rejects anything that would not survive as an identifier', () => {
    for (const prefix of ['', 'DBTX', '1abc', 'my-app', 'my app', 'ünïcode', 'a'.repeat(22), 'x"y']) {
      expect(() => assertValidPrefix(prefix), prefix).toThrow(/invalid prefix/)
    }
  })

  it('validates through resolveConfig, and defaults to dbtx', () => {
    expect(resolveConfig({ url: 'postgres://x' }).prefix).toBe('dbtx')
    expect(resolveConfig({ url: 'postgres://x' }).strategy).toBe('transaction')
    expect(resolveConfig({ url: 'postgres://x' }).resetSequences).toBe(false)
    expect(() => resolveConfig({ url: 'postgres://x', prefix: 'Bad-Prefix' })).toThrow(
      /invalid prefix/,
    )
  })

  it('builds context ids that leave room for the savepoint suffix', () => {
    const id = nextCtxId('a'.repeat(21))
    expect(id).toMatch(/^a{21}_\d+_\d+$/)
    expect(Buffer.byteLength(`${id}_sp_999999`)).toBeLessThanOrEqual(63)
  })
})
