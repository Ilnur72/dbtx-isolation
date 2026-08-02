import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/core/config.js'
import { getAmbient, recordFailure } from '../src/core/context.js'
import { patchPg, unpatchPg, type PgModuleLike } from '../src/drivers/pg.js'
import { makeTableFilter } from '../src/strategies/database.js'
import { makeStrategy } from '../src/strategies/index.js'
import type { ResolvedConfig } from '../src/types.js'

/*
 * The strategies against a fake pg module. The transaction strategy's
 * afterEach is the most important code in the library — it is what makes a
 * test's writes disappear — so it is exercised here without a database.
 */

type Status = 'I' | 'T' | 'E' | null

class FakeClient {
  readonly statements: string[] = []
  status: Status = null
  /** Set to hang the next ROLLBACK, standing in for a dead connection. */
  hangOnRollback = false
  release?: (err?: unknown) => void

  getTransactionStatus(): Status {
    return this.status
  }

  query(config: unknown, values?: unknown, callback?: unknown): unknown {
    const text = typeof config === 'string' ? config : (config as { text: string }).text
    this.statements.push(text)
    if (text === 'BEGIN') this.status = 'T'
    if (text === 'ROLLBACK') {
      if (this.hangOnRollback) return new Promise(() => {})
      this.status = 'I'
    }
    const cb = typeof values === 'function' ? values : callback
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        ;(cb as (e: unknown, r: unknown) => void)(null, { rows: [] })
      })
      return undefined
    }
    return Promise.resolve({ rows: [] })
  }
}

class FakePool {
  connect(cb?: unknown): unknown {
    const client = new FakeClient()
    client.release = (): void => {}
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        ;(cb as (e: unknown, c: FakeClient, r: unknown) => void)(undefined, client, client.release)
      })
      return undefined
    }
    return Promise.resolve(client)
  }

  end(): unknown {
    return Promise.resolve()
  }
}

const pg = { Client: FakeClient, Pool: FakePool } as unknown as PgModuleLike

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  ...resolveConfig({ url: 'postgres://user:pw@localhost:5432/myapp' }),
  ...overrides,
})

beforeEach(() => {
  patchPg(pg)
})

afterEach(() => {
  unpatchPg(pg)
  vi.restoreAllMocks()
})

describe('the transaction strategy', () => {
  it('installs a context for the test and takes it away afterwards', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()
    expect(getAmbient()).toBeDefined()
    await strategy.afterEach()
    expect(getAmbient()).toBeUndefined()
  })

  it('rolls back what the test wrote, and awaits it', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const client = new FakeClient()
    await client.query('INSERT INTO users DEFAULT VALUES')
    await strategy.afterEach()

    expect(client.statements).toEqual(['BEGIN', 'INSERT INTO users DEFAULT VALUES', 'ROLLBACK'])
    expect(client.status).toBe('I')
  })

  it('rolls back every client the test touched, not just the first', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const a = new FakeClient()
    const b = new FakeClient()
    await a.query('INSERT INTO users DEFAULT VALUES')
    await b.query('INSERT INTO orders DEFAULT VALUES')
    await strategy.afterEach()

    expect(a.statements).toContain('ROLLBACK')
    expect(b.statements).toContain('ROLLBACK')
  })

  it('leaves a read-only test alone', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const client = new FakeClient()
    await client.query('SELECT 1')
    const depth = getAmbient()?.depth
    await strategy.afterEach()

    expect(client.statements).toEqual(['SELECT 1'])
    expect(depth).toBe(0)
  })

  it('fails loudly when the backend says the transaction is already gone', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const client = new FakeClient()
    await client.query('INSERT INTO users DEFAULT VALUES')
    // As if an unrecognised COMMIT had reached the server.
    client.status = 'I'

    await expect(strategy.afterEach()).rejects.toThrow(/no longer inside the test transaction/)
    expect(getAmbient()).toBeUndefined()
  })

  it('accepts an aborted transaction, which rolls back perfectly well', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const client = new FakeClient()
    await client.query('INSERT INTO users DEFAULT VALUES')
    client.status = 'E'

    await expect(strategy.afterEach()).resolves.toBeUndefined()
  })

  it('surfaces a BEGIN that failed out of band', async () => {
    const strategy = makeStrategy('transaction', config())
    await strategy.beforeEach()

    const ctx = getAmbient()
    expect(ctx).toBeDefined()
    recordFailure(ctx!, new Error('BEGIN failed: connection refused'))

    await expect(strategy.afterEach()).rejects.toThrow(/connection refused/)
  })

  it('reports a rollback that never comes back instead of hanging the run', async () => {
    vi.useFakeTimers()
    try {
      const strategy = makeStrategy('transaction', config())
      await strategy.beforeEach()

      const client = new FakeClient()
      await client.query('INSERT INTO users DEFAULT VALUES')
      client.hangOnRollback = true

      const done = strategy.afterEach()
      const assertion = expect(done).rejects.toThrow(/ROLLBACK did not complete/)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns once when a test intercepted nothing at all', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const strategy = makeStrategy('transaction', config())

    await strategy.beforeEach()
    await strategy.afterEach()
    await strategy.beforeEach()
    await strategy.afterEach()

    // Warned at most once per worker; the same cause would repeat every test.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('turns that warning into a failure under strict', async () => {
    const strategy = makeStrategy('transaction', config({ strict: true }))
    await strategy.beforeEach()
    await expect(strategy.afterEach()).rejects.toThrow(/without a single database statement/)
  })

  it('has no run-level hooks: nothing is ever committed', () => {
    const strategy = makeStrategy('transaction', config())
    expect(strategy.globalSetup).toBeUndefined()
    expect(strategy.globalTeardown).toBeUndefined()
  })
})

describe('the database strategy', () => {
  it('does have run-level hooks, for the template', () => {
    const strategy = makeStrategy('database', config({ strategy: 'database' }))
    expect(strategy.globalSetup).toBeDefined()
    expect(strategy.globalTeardown).toBeDefined()
  })

  it('refuses to run against a patched driver', async () => {
    // The check looks at the real pg module, since that is the one the runner
    // patches — so this test has to patch that, not the fake.
    const realPg = (await import('pg')) as unknown as { default?: PgModuleLike }
    const target = realPg.default ?? (realPg as unknown as PgModuleLike)
    patchPg(target)
    try {
      const strategy = makeStrategy('database', config({ strategy: 'database' }))
      await expect(
        strategy.setup({ poolId: 1, url: 'postgres://localhost/x', global: { url: 'x' } }),
      ).rejects.toThrow(/must run against an unpatched driver/)
    } finally {
      unpatchPg(target)
    }
  })
})

describe('which tables get truncated', () => {
  const keep = makeTableFilter()

  it('empties ordinary tables', () => {
    for (const [schema, name] of [
      ['public', 'users'],
      ['public', 'orders'],
      ['app', 'sessions'],
      ['public', 'migration_notes'],
    ] as const) {
      expect(keep(schema, name), `${schema}.${name}`).toBe(true)
    }
  })

  it('never empties migration bookkeeping, whichever ORM wrote it', () => {
    for (const [schema, name] of [
      ['public', '_prisma_migrations'],
      ['public', '__drizzle_migrations'],
      ['drizzle', '__drizzle_migrations'],
      ['public', 'knex_migrations'],
      ['public', 'knex_migrations_lock'],
      ['public', 'migrations'],
      ['public', 'typeorm_metadata'],
      ['public', 'mikro_orm_migrations'],
      ['public', 'SequelizeMeta'],
    ] as const) {
      expect(keep(schema, name), `${schema}.${name}`).toBe(false)
    }
  })

  it('honours extra exclusions, bare, qualified or wildcarded', () => {
    expect(makeTableFilter(['reference_data'])('public', 'reference_data')).toBe(false)
    expect(makeTableFilter(['app.settings'])('app', 'settings')).toBe(false)
    expect(makeTableFilter(['app.settings'])('public', 'settings')).toBe(true)
    expect(makeTableFilter(['lookup_%'])('public', 'lookup_countries')).toBe(false)
    expect(makeTableFilter(['lookup_%'])('public', 'users')).toBe(true)
  })
})
