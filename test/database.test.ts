import type { Pool } from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  computeFingerprint,
  createTemplate,
  databaseNameFromUrl,
  dropDatabase,
  pruneOrphans,
  quoteIdent,
  quoteLiteral,
  templateName,
  urlForDatabase,
  withAdmin,
  workerDatabaseName,
} from '../src/admin.js'
import { resolveConfig } from '../src/core/config.js'
import { makeStrategy } from '../src/strategies/index.js'
import type { GlobalData, ResolvedConfig, Strategy } from '../src/types.js'
import { describeIntegration, outsideTest, pgApi, url, workerContext } from './helpers.js'

/*
 * The database strategy against a real Postgres, driving the Strategy hooks
 * directly. This is where the template machinery, cloning and truncation are
 * proved — including the crash and leftover scenarios, which are the ones that
 * fail silently if they are wrong.
 */

const PREFIX = 'dbtxit'

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...resolveConfig({
      url: url(),
      strategy: 'database',
      prefix: PREFIX,
      migrate: 'node test/apply-schema.mjs',
    }),
    ...overrides,
  }
}

async function databaseFlags(name: string): Promise<{ istemplate: boolean; allowconn: boolean }> {
  const rows = await outsideTest<Array<{ datistemplate: boolean; datallowconn: boolean }>>(
    'SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1',
    [name],
    urlForDatabase(url(), 'postgres'),
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no such database: ${name}`)
  return { istemplate: row.datistemplate, allowconn: row.datallowconn }
}

async function databaseExists(name: string): Promise<boolean> {
  const rows = await outsideTest<unknown[]>(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
    urlForDatabase(url(), 'postgres'),
  )
  return rows.length > 0
}

async function admin<T>(fn: Parameters<typeof withAdmin<T>>[1]): Promise<T> {
  return withAdmin({ url: url() }, fn)
}

/**
 * Drop a database the blunt way, for test fixtures only. A sealed template
 * cannot be dropped while it is still marked as one — which is why the library
 * itself goes through dropDatabase(), and why this helper has to do the same
 * two steps by hand.
 */
async function forceDrop(name: string): Promise<void> {
  await admin(async (client) => {
    await client
      .query(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`)
      .catch(() => undefined)
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
  })
}

describeIntegration('database strategy (real Postgres)', () => {
  const cleanup: string[] = []

  afterAll(async () => {
    await pruneOrphans({ url: url(), prefix: PREFIX, includeActive: true })
    for (const name of cleanup) {
      await forceDrop(name).catch(() => undefined)
    }
  })

  it('seals the template so parallel clones cannot race', async () => {
    const strategy = makeStrategy('database', config())
    const data = await strategy.globalSetup!()
    cleanup.push(data.template!)

    // This is the condition CREATE DATABASE ... TEMPLATE needs: nobody can
    // connect, so nobody can be connected.
    expect(await databaseFlags(data.template!)).toEqual({ istemplate: true, allowconn: false })
  })

  it('rebuilds a template an earlier run left half-built', async () => {
    const cfg = config()
    const fingerprint = await computeFingerprint({ url: cfg.url, migrate: cfg.migrate })
    const name = templateName(PREFIX, fingerprint)
    cleanup.push(name)

    // Wreckage of a run that died between CREATE DATABASE and the sealing
    // ALTER: it exists, it is unsealed, and its schema is incomplete.
    await forceDrop(name)
    await admin(async (client) => {
      await client.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`)
    })
    expect((await databaseFlags(name)).istemplate).toBe(false)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rebuilt = await createTemplate({
      url: cfg.url,
      prefix: PREFIX,
      fingerprint,
      migrate: cfg.migrate,
      cache: true, // even asked to reuse, it must refuse this one
    })
    const warnings = spy.mock.calls.map((call) => String(call))
    spy.mockRestore()

    expect(rebuilt.reused).toBe(false)
    expect(await databaseFlags(name)).toEqual({ istemplate: true, allowconn: false })
    expect(warnings.join('\n')).toMatch(/half-built/)
  })

  it('gives concurrent workers their own databases', async () => {
    const cfg = config()
    const strategy = makeStrategy('database', cfg)
    const data = await strategy.globalSetup!()
    cleanup.push(data.template!)

    const workers = [1, 2, 3].map(() => makeStrategy('database', cfg))
    const contexts = workers.map((_, index) =>
      workerContext({ poolId: index + 1, global: data as GlobalData }),
    )

    // All at once: cloning one sealed template from several workers is the
    // race the sealing is meant to remove.
    await Promise.all(workers.map((worker, index) => worker.setup(contexts[index]!)))

    const names = [1, 2, 3].map((poolId) =>
      workerDatabaseName(PREFIX, data.fingerprint!, poolId),
    )
    cleanup.push(...names)
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(await databaseExists(name)).toBe(true)

    await Promise.all(workers.map((worker, index) => worker.teardown(contexts[index]!)))
    for (const name of names) expect(await databaseExists(name)).toBe(false)
  }, 60_000)

  describeIntegration('per test', () => {
    let strategy: Strategy
    let data: GlobalData
    let pool: Pool
    let workerUrl: string

    beforeAll(async () => {
      const cfg = config()
      strategy = makeStrategy('database', cfg)
      data = await strategy.globalSetup!()
      cleanup.push(data.template!)

      const worker = workerContext({ poolId: 7, global: data })
      await strategy.setup(worker)

      const name = workerDatabaseName(PREFIX, data.fingerprint!, 7)
      cleanup.push(name)
      workerUrl = urlForDatabase(url(), name)
      const { Pool: PgPool } = await pgApi()
      pool = new PgPool({ connectionString: workerUrl })
    }, 60_000)

    afterAll(async () => {
      await pool.end()
      await strategy.teardown(workerContext({ poolId: 7, global: data }))
    })

    it('really commits, and truncation is what takes it away', async () => {
      await strategy.beforeEach()
      await pool.query("INSERT INTO users (name) VALUES ('committed-for-real')")

      // Visible from a different connection, which is the whole point of this
      // strategy: no outer transaction is hiding it.
      const seen = await outsideTest<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM users',
        [],
        workerUrl,
      )
      expect(seen[0]!.n).toBe(1)

      await strategy.afterEach()
      const after = await outsideTest<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM users',
        [],
        workerUrl,
      )
      expect(after[0]!.n).toBe(0)
    })

    it('restarts identity, so ids begin at 1 in every test', async () => {
      for (const _round of [1, 2, 3]) {
        await strategy.beforeEach()
        const { rows } = await pool.query("INSERT INTO users (name) VALUES ('seq') RETURNING id")
        expect((rows[0] as { id: number }).id).toBe(1)
        await strategy.afterEach()
      }
    })

    it('never truncates migration bookkeeping', async () => {
      await strategy.beforeEach()
      await pool.query("INSERT INTO users (name) VALUES ('x')")
      await strategy.afterEach()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM _prisma_migrations')
      // An ORM that finds this empty tries to run every migration again.
      expect((rows[0] as { n: number }).n).toBe(1)
    })

    it('cascades through foreign keys', async () => {
      await strategy.beforeEach()
      const { rows } = await pool.query("INSERT INTO users (name) VALUES ('parent') RETURNING id")
      await pool.query('INSERT INTO orders (user_id, total) VALUES ($1, 10)', [
        (rows[0] as { id: number }).id,
      ])
      await strategy.afterEach()

      const orders = await pool.query('SELECT count(*)::int AS n FROM orders')
      expect((orders.rows[0] as { n: number }).n).toBe(0)
    })

    /*
     * The reason this strategy exists. `CREATE INDEX CONCURRENTLY` cannot run
     * inside a transaction block, so it is refused under `transaction` — here
     * it simply works.
     */
    it('allows CREATE INDEX CONCURRENTLY, which transaction cannot', async () => {
      await strategy.beforeEach()
      await expect(
        pool.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS users_name_idx ON users (name)'),
      ).resolves.toBeDefined()
      await pool.query('DROP INDEX IF EXISTS users_name_idx')
      await strategy.afterEach()
    }, 30_000)
  })

  /*
   * Without inheriting the application database's locale, the template gets
   * the *server's* defaults from template0. When those differ, text sorts
   * differently in tests than in production and nothing says so: `a, B, c`
   * sorts as `a, B, c` under en_US and `B, a, c` under C.
   */
  it('gives the template the application database\'s locale, not the server default', async () => {
    const serverDefault = (
      await outsideTest<Array<{ datcollate: string }>>(
        "SELECT datcollate FROM pg_database WHERE datname = 'template0'",
        [],
        urlForDatabase(url(), 'postgres'),
      )
    )[0]!.datcollate

    // Something the server has that is not what it would pick by itself. `C`
    // always exists; when it is already the default, try a UTF-8 locale.
    const candidates = serverDefault === 'C' ? ['en_US.utf8', 'en_US.UTF-8'] : ['C']
    const appDatabase = 'dbtxlocaleapp'
    let chosen: string | undefined

    for (const candidate of candidates) {
      await forceDrop(appDatabase)
      try {
        await admin(async (client) => {
          await client.query(
            `CREATE DATABASE ${quoteIdent(appDatabase)} TEMPLATE template0 ` +
              `LC_COLLATE ${quoteLiteral(candidate)} LC_CTYPE ${quoteLiteral(candidate)}`,
          )
        })
        chosen = candidate
        break
      } catch {
        // Not installed on this server; try the next one.
      }
    }

    if (chosen === undefined) {
      // Nothing to compare against on this server, so there is nothing to prove.
      return
    }
    cleanup.push(appDatabase)

    const appUrl = urlForDatabase(url(), appDatabase)
    const fingerprint = await computeFingerprint({ url: appUrl })
    const { name } = await createTemplate({ url: appUrl, prefix: PREFIX, fingerprint })
    cleanup.push(name)

    const collate = (
      await outsideTest<Array<{ datcollate: string }>>(
        'SELECT datcollate FROM pg_database WHERE datname = $1',
        [name],
        urlForDatabase(url(), 'postgres'),
      )
    )[0]!.datcollate

    expect(collate).toBe(chosen)
    expect(collate).not.toBe(serverDefault)
  }, 60_000)

  describeIntegration('pruning leftovers', () => {
    it('drops an idle leftover and spares a busy one', async () => {
      const idle = `${PREFIX}_orphan_idle`
      const busy = `${PREFIX}_orphan_busy`
      cleanup.push(idle, busy)

      for (const name of [idle, busy]) {
        await forceDrop(name)
        await admin(async (client) => {
          await client.query(`CREATE DATABASE ${quoteIdent(name)}`)
        })
      }

      const { Pool: PgPool } = await pgApi()
      const holder = new PgPool({ connectionString: urlForDatabase(url(), busy), max: 1 })
      await holder.query('SELECT 1')
      try {
        const dropped = await pruneOrphans({ url: url(), prefix: PREFIX })
        expect(dropped).toContain(idle)
        // Someone else's run may still own this one.
        expect(dropped).not.toContain(busy)
        expect(await databaseExists(busy)).toBe(true)
      } finally {
        await holder.end()
      }

      const forced = await pruneOrphans({ url: url(), prefix: PREFIX, includeActive: true })
      expect(forced).toContain(busy)
    }, 30_000)

    /*
     * A live regression test for the LIKE escaping. The application database
     * here is `dbtxtestapp`: it starts with the default prefix but has no
     * underscore after it, so the correct pattern `dbtx\_%` misses it while a
     * naive `dbtx%` would match — and prune would drop the developer's
     * database.
     */
    it('never matches a database that merely starts with the prefix', async () => {
      const application = databaseNameFromUrl(url())
      const dropped = await pruneOrphans({ url: url(), prefix: 'dbtx' })

      expect(dropped).not.toContain(application)
      expect(await databaseExists(application)).toBe(true)
    })

    it('leaves databases that are not ours alone', async () => {
      const application = databaseNameFromUrl(url())
      await admin(async (client) => {
        await expect(
          dropDatabase(client, application, { prefix: PREFIX, applicationDatabase: application }),
        ).rejects.toThrow(/DATABASE_URL points at/)
        await expect(
          dropDatabase(client, 'postgres', { prefix: PREFIX, applicationDatabase: application }),
        ).rejects.toThrow(/system database/)
      })
      expect(await databaseExists(application)).toBe(true)
    })
  })
})
