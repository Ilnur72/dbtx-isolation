import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newCtx, setAmbient, type TestCtx } from '../src/core/context.js'
import {
  DbtxRollbackTimeoutError,
  exempt,
  hasBegun,
  isPatched,
  patchPg,
  releasePins,
  rollbackClient,
  unpatchPg,
  type PgModuleLike,
} from '../src/drivers/pg.js'

/*
 * A stand-in for `pg` that mirrors the parts of its contract the patch relies
 * on: query() returns a promise, `undefined` plus a callback, or the
 * Submittable it was handed; the pool assigns `release` per acquire. No
 * database involved.
 */

interface Submittable {
  submit: () => void
  text: string
  callback?: (err: unknown, res?: unknown) => void
}

class FakeClient {
  readonly statements: string[] = []
  release?: (err?: unknown) => void

  query(config: unknown, values?: unknown, callback?: unknown): unknown {
    if (typeof config === 'object' && config !== null && typeof (config as Submittable).submit === 'function') {
      const submittable = config as Submittable
      this.statements.push(submittable.text)
      return submittable
    }
    const text = typeof config === 'string' ? config : (config as { text: string }).text
    this.statements.push(text)
    const cb = typeof values === 'function' ? values : callback
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        ;(cb as (err: unknown, res: unknown) => void)(null, { rows: [] })
      })
      return undefined
    }
    return Promise.resolve({ rows: [] })
  }
}

class FakePool {
  readonly acquired: FakeClient[] = []
  readonly releaseCalls: unknown[] = []
  ended = false

  connect(cb?: unknown): unknown {
    const client = new FakeClient()
    client.release = (err?: unknown): void => {
      this.releaseCalls.push(err)
    }
    this.acquired.push(client)
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        ;(cb as (e: unknown, c: FakeClient, r: unknown) => void)(undefined, client, client.release)
      })
      return undefined
    }
    return Promise.resolve(client)
  }

  end(cb?: unknown): unknown {
    this.ended = true
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        ;(cb as (e?: unknown) => void)()
      })
      return undefined
    }
    return Promise.resolve()
  }
}

const fakePg = (): PgModuleLike =>
  ({ Client: FakeClient, Pool: FakePool }) as unknown as PgModuleLike

/** The prototypes are shared, so each test patches and unpatches around itself. */
let pg: PgModuleLike
let ctx: TestCtx

beforeEach(() => {
  pg = fakePg()
  patchPg(pg)
  ctx = newCtx('t1')
  setAmbient(ctx)
})

afterEach(async () => {
  await releasePins()
  setAmbient(undefined)
  unpatchPg(pg)
  vi.restoreAllMocks()
})

const client = (): FakeClient => new FakeClient()

describe('lazy BEGIN', () => {
  it('does not open a transaction for a read', async () => {
    const c = client()
    await c.query('SELECT 1')
    expect(c.statements).toEqual(['SELECT 1'])
    expect(hasBegun(c)).toBe(false)
    expect(ctx.depth).toBe(0)
  })

  it('opens one before the first write, on that same client', async () => {
    const c = client()
    await c.query('INSERT INTO users (name) VALUES ($1)', ['a'])
    expect(c.statements).toEqual(['BEGIN', 'INSERT INTO users (name) VALUES ($1)'])
    expect(hasBegun(c)).toBe(true)
    expect(ctx.clients.has(c)).toBe(true)
  })

  it('opens it only once per client', async () => {
    const c = client()
    await c.query('INSERT INTO users DEFAULT VALUES')
    await c.query('DELETE FROM users')
    expect(c.statements.filter((s) => s === 'BEGIN')).toHaveLength(1)
  })

  it('does not double-BEGIN when two writes start in the same tick', async () => {
    const c = client()
    await Promise.all([c.query('INSERT INTO a DEFAULT VALUES'), c.query('INSERT INTO b DEFAULT VALUES')])
    expect(c.statements.filter((s) => s === 'BEGIN')).toHaveLength(1)
  })

  it('leaves exempt maintenance connections alone', async () => {
    const c = exempt(client())
    await c.query('TRUNCATE users')
    await c.query('BEGIN')
    expect(c.statements).toEqual(['TRUNCATE users', 'BEGIN'])
    expect(hasBegun(c)).toBe(false)
  })

  it('does nothing at all with no active test', async () => {
    setAmbient(undefined)
    const c = client()
    await c.query('INSERT INTO users DEFAULT VALUES')
    await c.query('BEGIN')
    expect(c.statements).toEqual(['INSERT INTO users DEFAULT VALUES', 'BEGIN'])
  })
})

describe('the query() overloads', () => {
  it('rewrites query(text)', async () => {
    const c = client()
    await c.query('BEGIN')
    expect(c.statements).toEqual(['BEGIN', 'SAVEPOINT "t1_sp_1"'])
    expect(ctx.depth).toBe(1)
  })

  it('rewrites query(config) without mutating the caller object', async () => {
    const c = client()
    const config = { text: 'BEGIN', values: [] }
    await c.query(config)
    expect(c.statements).toEqual(['BEGIN', 'SAVEPOINT "t1_sp_1"'])
    expect(config.text).toBe('BEGIN')
  })

  it('rewrites query(text, cb) and still calls the callback', async () => {
    const c = client()
    const seen = await new Promise<unknown>((resolve) => {
      const returned = c.query('BEGIN', (_err: unknown, res: unknown) => {
        resolve(res)
      })
      expect(returned).toBeUndefined()
    })
    expect(seen).toEqual({ rows: [] })
    expect(c.statements).toEqual(['BEGIN', 'SAVEPOINT "t1_sp_1"'])
  })

  it('rewrites query(text, values, cb) and still calls the callback', async () => {
    const c = client()
    await new Promise<void>((resolve) => {
      c.query('INSERT INTO users (name) VALUES ($1)', ['a'], () => {
        resolve()
      })
    })
    expect(c.statements).toEqual(['BEGIN', 'INSERT INTO users (name) VALUES ($1)'])
  })

  it('rewrites a Submittable in place and returns it synchronously', () => {
    const c = client()
    const cursor = { submit: (): void => {}, text: 'BEGIN' }
    const returned = c.query(cursor)
    expect(returned).toBe(cursor)
    expect(cursor.text).toBe('SAVEPOINT "t1_sp_1"')
    expect(c.statements).toEqual(['BEGIN', 'SAVEPOINT "t1_sp_1"'])
  })

  it('treats a Submittable with no readable text as a write', () => {
    const c = client()
    const weird = { submit: (): void => {} } as unknown as { submit: () => void; text: string }
    c.query(weird)
    expect(hasBegun(c)).toBe(true)
  })

  it('passes a null query straight through to pg, which owns that error', () => {
    const c = client()
    expect(() => c.query(null)).toThrow(TypeError)
    expect(hasBegun(c)).toBe(false)
  })
})

describe('pinned connections', () => {
  it('hands out the same client for every connect on a pool', async () => {
    const pool = new FakePool()
    const a = await pool.connect()
    const b = await pool.connect()
    expect(a).toBe(b)
    expect(pool.acquired).toHaveLength(1)
  })

  it('pins the same client for the callback form too', async () => {
    const pool = new FakePool()
    const a = await pool.connect()
    const b = await new Promise((resolve) => {
      pool.connect((_err: unknown, c: unknown) => {
        resolve(c)
      })
    })
    expect(b).toBe(a)
  })

  it('gives concurrent connects one connection, not two', async () => {
    const pool = new FakePool()
    const [a, b] = await Promise.all([pool.connect(), pool.connect()])
    expect(a).toBe(b)
    expect(pool.acquired).toHaveLength(1)
  })

  it('makes release() a no-op so the ORM cannot end the transaction', async () => {
    const pool = new FakePool()
    const c = (await pool.connect()) as FakeClient
    c.release?.()
    expect(pool.releaseCalls).toEqual([])
  })

  it('logs release(err) rather than swallowing it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = new FakePool()
    const c = (await pool.connect()) as FakeClient
    c.release?.(new Error('connection lost'))
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0])).toMatch(/release\(err\)/)
    expect(pool.releaseCalls).toEqual([])
  })

  it('restores release and returns the connection when the pins are released', async () => {
    const pool = new FakePool()
    const c = (await pool.connect()) as FakeClient
    await releasePins()
    expect(pool.releaseCalls).toEqual([undefined])
    // Unpinned: the next connect goes to the pool again.
    const next = await pool.connect()
    expect(next).not.toBe(c)
  })

  it('releases the pinned connection before ending the pool', async () => {
    const pool = new FakePool()
    await pool.connect()
    await pool.end()
    expect(pool.releaseCalls).toEqual([undefined])
    expect(pool.ended).toBe(true)
  })
})

describe('rollbackClient', () => {
  it('rolls back through the unpatched query, so nothing rewrites it', async () => {
    const c = client()
    await c.query('INSERT INTO users DEFAULT VALUES')
    await rollbackClient(c)
    expect(c.statements).toEqual(['BEGIN', 'INSERT INTO users DEFAULT VALUES', 'ROLLBACK'])
    expect(hasBegun(c)).toBe(false)
  })

  it('does nothing for a client that never began', async () => {
    const c = client()
    await c.query('SELECT 1')
    await rollbackClient(c)
    expect(c.statements).toEqual(['SELECT 1'])
  })

  it('reports a failed rollback instead of failing the test silently', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Unpatched, so rollbackClient falls back to the client's own query and
    // the rejection can be staged; the saved original is deliberately immune
    // to an instance-level override.
    unpatchPg(pg)
    const c = client()
    ;(c as unknown as Record<symbol, unknown>)[Symbol.for('dbtx.begun')] = true
    vi.spyOn(c, 'query').mockRejectedValue(new Error('connection terminated'))

    // Returned, not thrown: the caller still has other clients to roll back.
    await expect(rollbackClient(c)).resolves.toBeInstanceOf(Error)
    expect(String(spy.mock.calls[0])).toMatch(/ROLLBACK failed/)
    expect(hasBegun(c)).toBe(false)

    patchPg(pg)
  })

  it('gives up on a rollback that never answers, rather than hanging the run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    unpatchPg(pg)
    const c = client()
    ;(c as unknown as Record<symbol, unknown>)[Symbol.for('dbtx.begun')] = true
    vi.spyOn(c, 'query').mockReturnValue(new Promise(() => {}))

    const failure = await rollbackClient(c, { timeoutMs: 20 })
    expect(failure).toBeInstanceOf(DbtxRollbackTimeoutError)
    expect(String(failure)).toMatch(/later tests may see its rows/)

    patchPg(pg)
  })
})

describe('patching is reversible and idempotent', () => {
  it('does not wrap twice', async () => {
    expect(patchPg(pg)).toBe(false)
    const c = client()
    await c.query('INSERT INTO users DEFAULT VALUES')
    expect(c.statements).toEqual(['BEGIN', 'INSERT INTO users DEFAULT VALUES'])
  })

  it('restores the original methods', async () => {
    const before = FakeClient.prototype.query
    expect(isPatched(pg)).toBe(true)
    expect(unpatchPg(pg)).toBe(true)
    expect(isPatched(pg)).toBe(false)
    expect(FakeClient.prototype.query).not.toBe(before)

    const c = client()
    await c.query('BEGIN')
    expect(c.statements).toEqual(['BEGIN'])

    patchPg(pg) // leave the state the afterEach hook expects
  })

  it('reports nothing to undo when it was never patched', () => {
    unpatchPg(pg)
    expect(unpatchPg(pg)).toBe(false)
    patchPg(pg)
  })
})
