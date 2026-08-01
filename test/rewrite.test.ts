import { describe, expect, it } from 'vitest'
import { newCtx } from '../src/core/context.js'
import { needsTransaction, rewrite, SUPPRESSED } from '../src/core/rewrite.js'

// SPEC §7, criteria 1-7. These must pass with no database available.

const ctx = (): ReturnType<typeof newCtx> => newCtx('t1')

describe('criterion 1 — BEGIN and START TRANSACTION produce savepoints', () => {
  it('rewrites BEGIN and increments depth', () => {
    const c = ctx()
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_1"')
    expect(c.depth).toBe(1)
  })

  it('rewrites START TRANSACTION and increments depth', () => {
    const c = ctx()
    expect(rewrite('START TRANSACTION', c)).toBe('SAVEPOINT "t1_1"')
    expect(c.depth).toBe(1)
  })

  it('numbers nested savepoints by depth', () => {
    const c = ctx()
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_1"')
    expect(rewrite('BEGIN', c)).toBe('SAVEPOINT "t1_2"')
    expect(rewrite('START TRANSACTION', c)).toBe('SAVEPOINT "t1_3"')
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
      expect(rewrite(sql, c), sql).toBe('SAVEPOINT "t1_1"')
      expect(c.depth, sql).toBe(1)
    }
  })

  it('prefixes savepoint names per context so parallel tests cannot collide', () => {
    const a = newCtx('ctx_a')
    const b = newCtx('ctx_b')
    expect(rewrite('BEGIN', a)).toBe('SAVEPOINT "ctx_a_1"')
    expect(rewrite('BEGIN', b)).toBe('SAVEPOINT "ctx_b_1"')
  })
})

describe('criterion 2 — COMMIT releases the savepoint and decrements depth', () => {
  it('releases the savepoint at the current depth', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_1"')
    expect(c.depth).toBe(0)
  })

  it('unwinds nested transactions in order', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    rewrite('BEGIN', c)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_2"')
    expect(c.depth).toBe(1)
    expect(rewrite('COMMIT', c)).toBe('RELEASE SAVEPOINT "t1_1"')
    expect(c.depth).toBe(0)
  })

  it('treats END as the COMMIT alias it is', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('END', c)).toBe('RELEASE SAVEPOINT "t1_1"')
    expect(c.depth).toBe(0)
  })

  it('accepts the syntactic variants ORMs emit', () => {
    for (const sql of ['commit', 'COMMIT;', ' COMMIT ', 'COMMIT WORK', 'COMMIT TRANSACTION']) {
      const c = ctx()
      rewrite('BEGIN', c)
      expect(rewrite(sql, c), sql).toBe('RELEASE SAVEPOINT "t1_1"')
      expect(c.depth, sql).toBe(0)
    }
  })
})

describe('criterion 3 — bare ROLLBACK rolls back to the savepoint', () => {
  it('rolls back to the savepoint at the current depth', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    expect(rewrite('ROLLBACK', c)).toBe('ROLLBACK TO SAVEPOINT "t1_1"')
    expect(c.depth).toBe(0)
  })

  it('discards only the inner level when nested', () => {
    const c = ctx()
    rewrite('BEGIN', c)
    rewrite('BEGIN', c)
    expect(rewrite('ROLLBACK', c)).toBe('ROLLBACK TO SAVEPOINT "t1_2"')
    expect(c.depth).toBe(1)
  })

  it('accepts the syntactic variants ORMs emit', () => {
    for (const sql of ['rollback', 'ROLLBACK;', ' ROLLBACK ', 'ROLLBACK WORK', 'ROLLBACK TRANSACTION']) {
      const c = ctx()
      rewrite('BEGIN', c)
      expect(rewrite(sql, c), sql).toBe('ROLLBACK TO SAVEPOINT "t1_1"')
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

  it('suppresses END too', () => {
    const c = ctx()
    expect(rewrite('END', c)).toBe(SUPPRESSED)
    expect(c.depth).toBe(0)
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

  it('treats EXPLAIN ANALYZE as a write, because it executes the statement', () => {
    expect(needsTransaction('EXPLAIN ANALYZE INSERT INTO users DEFAULT VALUES')).toBe(true)
    expect(needsTransaction('EXPLAIN (ANALYZE, BUFFERS) INSERT INTO users DEFAULT VALUES')).toBe(true)
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
