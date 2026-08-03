import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/core/config.js'
import { getAmbient, withBypass } from '../src/core/context.js'
import { checkIsolation, hasBegun, pinnedClients, transactionStatus } from '../src/drivers/pg.js'
import { makeStrategy } from '../src/strategies/index.js'
import type { Strategy } from '../src/types.js'
import { applySchema, describeIntegration, outsideTest, pgApi, url, workerContext } from './helpers.js'

/*
 * The transaction strategy against a real Postgres, driving the Strategy hooks
 * directly rather than through the Vitest runner. If something breaks here, it
 * broke in the core — not in the runner glue, which arrives later.
 *
 * SPEC §7, criteria 8-13, plus the behaviours that only a real server can
 * confirm: connection pinning, transaction status, now() semantics.
 */

describeIntegration('transaction strategy (real Postgres)', () => {
  let strategy: Strategy
  let pool: Pool
  const extraPools: Pool[] = []

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
    return (rows[0] as { n: number }).n
  }

  beforeAll(async () => {
    await applySchema()
    strategy = makeStrategy('transaction', resolveConfig({ url: url() }))
    await strategy.setup(workerContext())
    const { Pool: PgPool } = await pgApi()
    pool = new PgPool({ connectionString: url() })
  })

  afterAll(async () => {
    await Promise.all([pool, ...extraPools].map((p) => p.end()))
    await strategy.teardown(workerContext())
    // Anything an escape-hatch test committed on purpose.
    await outsideTest('TRUNCATE orders, users RESTART IDENTITY CASCADE')
  })

  describeIntegration('isolation', () => {
    beforeEach(async () => {
      await strategy.beforeEach()
    })
    afterEach(async () => {
      await strategy.afterEach()
    })

    // Criterion 8, in two halves.
    it('writes a row', async () => {
      await pool.query("INSERT INTO users (name) VALUES ('alice')")
      expect(await count('users')).toBe(1)
    })

    it('does not see the row the previous test wrote', async () => {
      expect(await count('users')).toBe(0)
    })

    // Criterion 10.
    it("keeps the application's own BEGIN ... COMMIT visible inside the test", async () => {
      await pool.query('BEGIN')
      await pool.query("INSERT INTO users (name) VALUES ('committed')")
      await pool.query('COMMIT')
      expect(await count('users')).toBe(1)
      expect(getAmbient()?.depth).toBe(0)
    })

    it('and gone again afterwards', async () => {
      expect(await count('users')).toBe(0)
    })

    // Criterion 11.
    it('discards only the inner work of a nested BEGIN ... ROLLBACK', async () => {
      await pool.query("INSERT INTO users (name) VALUES ('outer')")
      await pool.query('BEGIN')
      await pool.query("INSERT INTO users (name) VALUES ('inner')")
      await pool.query('ROLLBACK')

      const { rows } = await pool.query('SELECT name FROM users ORDER BY name')
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['outer'])
      expect(getAmbient()?.depth).toBe(0)
    })

    it("leaves the application's own savepoints alone", async () => {
      await pool.query("INSERT INTO users (name) VALUES ('keep')")
      await pool.query('SAVEPOINT my_sp')
      await pool.query("INSERT INTO users (name) VALUES ('drop')")
      await pool.query('ROLLBACK TO SAVEPOINT my_sp')

      const { rows } = await pool.query('SELECT name FROM users ORDER BY name')
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['keep'])
    })

    // Criterion 12.
    it('opens no transaction at all for a read-only test', async () => {
      await pool.query('SELECT 1')
      expect(getAmbient()?.depth).toBe(0)
      expect(pinnedClients().some((c) => hasBegun(c))).toBe(false)
    })

    it('keeps the outer transaction across every COMMIT and ROLLBACK alias', async () => {
      await pool.query("INSERT INTO users (name) VALUES ('aliases')")
      for (const alias of ['END', 'ABORT', 'COMMIT WORK', 'ROLLBACK TRANSACTION', 'end']) {
        await pool.query(alias)
      }
      // Still inside the test transaction: none of those reached the server.
      expect(pinnedClients().map((c) => transactionStatus(c))).toEqual(['T'])
      expect(await count('users')).toBe(1)
    })

    it('recovers from an aborted transaction', async () => {
      await pool.query("INSERT INTO users (name) VALUES ('dup')")
      await expect(pool.query("INSERT INTO users (name) VALUES ('dup')")).rejects.toThrow(
        /duplicate key/i,
      )

      // checkIsolation does a round trip first, because the status lags a
      // rejected query by one protocol message; reading it raw here would see
      // the stale 'T'. An aborted transaction is still a transaction, so this
      // is not a breach.
      const [pinned] = pinnedClients()
      await expect(checkIsolation(pinned!)).resolves.toBeUndefined()
      expect(transactionStatus(pinned!)).toBe('E')
    })

    it('starts clean after that abort', async () => {
      expect(await count('users')).toBe(0)
    })

    it('refuses statements that cannot work inside a transaction', async () => {
      await expect(pool.query('VACUUM')).rejects.toThrow(/strategy: 'database'/)
      await expect(pool.query('CREATE INDEX CONCURRENTLY i ON users (name)')).rejects.toThrow(
        /CREATE INDEX CONCURRENTLY/,
      )
    })

    it('intercepts a Submittable, the Cursor and QueryStream path', async () => {
      const { Query } = await pgApi()
      const client = await pool.connect()
      await client.query("INSERT INTO users (name) VALUES ('submittable')")

      const submittable = new Query('BEGIN')
      const finished = new Promise<void>((resolve, reject) => {
        submittable.on('end', () => {
          resolve()
        })
        submittable.on('error', reject)
      })
      client.query(submittable as never)
      await finished

      // Rewritten in place, because a Cursor cannot be cloned. `text` is on
      // the object at runtime; @types/pg just does not declare it.
      const rewritten = (submittable as unknown as { text: string }).text
      expect(rewritten).toMatch(/^SAVEPOINT "dbtx_.*_sp_1"$/)
      expect(getAmbient()?.depth).toBe(1)
      client.release()
    })

    it('gives one pool exactly one backend, however it is reached', async () => {
      const pid = async (): Promise<number> => {
        const { rows } = await pool.query('SELECT pg_backend_pid() AS pid')
        return (rows[0] as { pid: number }).pid
      }

      const first = await pid()
      await pool.query("INSERT INTO users (name) VALUES ('pinned')")
      expect(await pid()).toBe(first)

      // Checking a client out and handing it back must not move us either.
      const client = await pool.connect()
      const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
      expect((rows[0] as { pid: number }).pid).toBe(first)
      client.release()
      expect(await pid()).toBe(first)
    })

    it('serialises concurrent writes on one pool instead of deadlocking', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          pool.query('INSERT INTO users (name) VALUES ($1)', [`concurrent-${i}`]),
        ),
      )
      expect(await count('users')).toBe(10)
    })

    it('rolls back every pool the test touched', async () => {
      const { Pool: PgPool } = await pgApi()
      const second = new PgPool({ connectionString: url() })
      extraPools.push(second)

      await pool.query("INSERT INTO users (name) VALUES ('from-pool-one')")
      await second.query("INSERT INTO users (name) VALUES ('from-pool-two')")
      expect(pinnedClients()).toHaveLength(2)
    })

    it('leaves nothing behind from either pool', async () => {
      expect(await count('users')).toBe(0)
    })

    /*
     * Documented consequence of pinning (SPEC §3.3), pinned down by a test so
     * nobody "fixes" it by accident. Two `connect()` calls hand back the same
     * connection, so code that assumes two independent sessions sees writes
     * that have not been committed. The spec predicted a hang; with one
     * connection per pool there is nothing to wait for, so the real symptom is
     * this visibility instead.
     */
    it('hands the same connection to code that expects two', async () => {
      const [a, b] = await Promise.all([pool.connect(), pool.connect()])
      expect(a).toBe(b)

      await a.query("INSERT INTO users (name) VALUES ('shared-session')")
      const { rows } = await b.query('SELECT count(*)::int AS n FROM users')
      expect((rows[0] as { n: number }).n).toBe(1)

      a.release()
      b.release()
    })

    /*
     * Postgres semantics, not a dbtx bug: inside a transaction `now()` is the
     * transaction's start time. It is in the README's caveats, and this test is
     * here so the behaviour cannot drift silently.
     */
    it('freezes now() for the whole test, while statement_timestamp() moves', async () => {
      await pool.query("INSERT INTO users (name) VALUES ('clock')")
      const first = await pool.query('SELECT now() AS now, statement_timestamp() AS stmt')
      await new Promise((resolve) => setTimeout(resolve, 10))
      const second = await pool.query('SELECT now() AS now, statement_timestamp() AS stmt')

      const at = (r: { rows: unknown[] }, key: 'now' | 'stmt'): number =>
        (r.rows[0] as Record<string, Date>)[key]!.getTime()

      expect(at(second, 'now')).toBe(at(first, 'now'))
      expect(at(second, 'stmt')).toBeGreaterThan(at(first, 'stmt'))
    })

    // Criterion 13, on the primitive `dbtx.uncommitted` is built from; the
    // public wrapper arrives with the runner in step 7.
    it('escapes isolation inside withBypass, and restores the previous state', async () => {
      const ctx = getAmbient()
      expect(ctx?.bypass).toBe(false)

      await withBypass(async () => {
        expect(getAmbient()?.bypass).toBe(true)
        // Not intercepted, so this reaches its own connection and commits.
        await pool.query("INSERT INTO users (name) VALUES ('escaped')")
        await withBypass(async () => {
          expect(getAmbient()?.bypass).toBe(true)
        })
        // Restored to the *previous* value, which was true here.
        expect(getAmbient()?.bypass).toBe(true)
      })

      expect(ctx?.bypass).toBe(false)
    })

    it('kept the escaped row, because that is what escaping means', async () => {
      const rows = await outsideTest<Array<{ name: string }>>('SELECT name FROM users')
      expect(rows.map((r) => r.name)).toEqual(['escaped'])
      await outsideTest('TRUNCATE orders, users RESTART IDENTITY CASCADE')
    })
  })

  /*
   * Runs before the sequence-reset block on purpose: that block's teardown
   * unpatches the driver, which is correct for a worker that owns one strategy
   * but means anything after it in this file would see an unpatched pg.
   */
  describeIntegration('failure reporting', () => {
    it('reports a transaction that something else committed', async () => {
      await strategy.beforeEach()
      await pool.query("INSERT INTO users (name) VALUES ('breach')")

      // Commit it behind dbtx's back. Sent normally, this COMMIT would be
      // rewritten away at depth 0 — which is the protection working — so the
      // bypass is what makes it reach the server, exactly as an alias dbtx
      // failed to recognise would.
      const [pinned] = pinnedClients()
      expect(pinned).toBeDefined()
      await withBypass(async () => {
        await (pinned as unknown as { query: (sql: string) => Promise<unknown> }).query('COMMIT')
      })

      await expect(strategy.afterEach()).rejects.toThrow(/no longer inside the test transaction/)
      await outsideTest('TRUNCATE orders, users RESTART IDENTITY CASCADE')
    })

    it('ends the pool cleanly even while a connection is pinned', async () => {
      const { Pool: PgPool } = await pgApi()
      const doomed = new PgPool({ connectionString: url() })

      await strategy.beforeEach()
      await doomed.query("INSERT INTO users (name) VALUES ('ending')")
      // Would hang forever if end() waited for the pinned connection.
      await expect(doomed.end()).resolves.toBeUndefined()
      await strategy.afterEach().catch(() => undefined)
      await outsideTest('TRUNCATE orders, users RESTART IDENTITY CASCADE')
    }, 15_000)

    it('is quiet about rollbacks that succeed', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await strategy.beforeEach()
      await pool.query("INSERT INTO users (name) VALUES ('quiet')")
      await strategy.afterEach()
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })
  describeIntegration('sequence resets', () => {
    let resetting: Strategy

    beforeAll(async () => {
      resetting = makeStrategy(
        'transaction',
        resolveConfig({ url: url(), resetSequences: true }),
      )
      await resetting.setup(workerContext())
    })

    afterAll(async () => {
      await resetting.teardown(workerContext())
    })

    beforeEach(async () => {
      await resetting.beforeEach()
    })
    afterEach(async () => {
      await resetting.afterEach()
    })

    // Criterion 9, asserted twice: the point is that it holds in *every* test.
    for (const round of [1, 2, 3]) {
      it(`starts ids at 1 again (round ${round})`, async () => {
        const { rows } = await pool.query(
          "INSERT INTO users (name) VALUES ('seq') RETURNING id",
        )
        expect((rows[0] as { id: number }).id).toBe(1)
      })
    }
  })

})
