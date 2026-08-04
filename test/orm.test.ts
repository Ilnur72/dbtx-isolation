import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { resolveConfig } from '../src/core/config.js'
import { makeStrategy } from '../src/strategies/index.js'
import type { Strategy } from '../src/types.js'
import { applySchema, describeIntegration, outsideTest, pgApi, url, workerContext } from './helpers.js'

/*
 * The claim the whole package rests on.
 *
 * Prisma 7 reaches the database through a driver adapter over plain `pg`, so
 * patching `pg` should isolate it without Prisma knowing dbtx exists. If that
 * is not true, dbtx has no advantage over the Prisma-only and
 * Prisma-incompatible tools it exists to replace — so it is proved here rather
 * than asserted in the README.
 *
 * Drizzle is included too, but it is the easy case: it sits openly on `pg`.
 */

describeIntegration('ORMs on top of pg', () => {
  let strategy: Strategy
  let pool: Pool

  beforeAll(async () => {
    await applySchema()
    strategy = makeStrategy('transaction', resolveConfig({ url: url() }))
    await strategy.setup(workerContext())
    const { Pool: PgPool } = await pgApi()
    pool = new PgPool({ connectionString: url() })
  })

  afterAll(async () => {
    await pool.end()
    await strategy.teardown(workerContext())
    await outsideTest('TRUNCATE orders, users RESTART IDENTITY CASCADE')
  })

  beforeEach(async () => {
    await strategy.beforeEach()
  })

  afterEach(async () => {
    await strategy.afterEach()
  })

  describeIntegration('Prisma 7 through its pg driver adapter', () => {
    interface PrismaLike {
      user: {
        create: (args: unknown) => Promise<{ id: number; name: string }>
        findMany: (args?: unknown) => Promise<Array<{ name: string }>>
        count: () => Promise<number>
      }
      $transaction: (fn: (tx: PrismaLike) => Promise<unknown>) => Promise<unknown>
      $disconnect: () => Promise<void>
    }

    /** `source` is either a connection string or an existing pg Pool. */
    async function prisma(source: string | Pool): Promise<PrismaLike> {
      const { PrismaPg } = await import('@prisma/adapter-pg')
      const { PrismaClient } = (await import(
        '../node_modules/.prisma-dbtx/client/client.js'
      )) as unknown as { PrismaClient: new (options: unknown) => PrismaLike }

      return new PrismaClient({ adapter: new PrismaPg(source as never) })
    }

    it('isolates Prisma without Prisma knowing dbtx exists', async () => {
      const client = await prisma(url())
      try {
        await client.user.create({ data: { name: 'via-prisma' } })
        // Read back through Prisma: its adapter builds its own pool, so this
        // is its own pinned connection and its own test transaction.
        expect(await client.user.count()).toBe(1)
      } finally {
        await client.$disconnect()
      }
    })

    it('and the row is gone in the next test', async () => {
      const client = await prisma(url())
      try {
        expect(await client.user.count()).toBe(0)
      } finally {
        await client.$disconnect()
      }
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
      expect((rows[0] as { n: number }).n).toBe(0)
    })

    /*
     * The two-pool caveat, in the shape people will actually meet it: an
     * adapter given a connection string builds its own pool, so it gets its
     * own pinned session and cannot see uncommitted rows written through the
     * application's pool. This is documented behaviour, not a defect — the fix
     * is the next test.
     */
    it('does not share a session when it builds its own pool', async () => {
      const client = await prisma(url())
      try {
        await pool.query("INSERT INTO users (name) VALUES ('via-pg')")
        expect(await client.user.count()).toBe(0)
      } finally {
        await client.$disconnect()
      }
    })

    it('shares everything when handed the application pool', async () => {
      // PrismaPg accepts an existing pg.Pool, which is what you want under
      // dbtx: one pool, one pinned connection, one transaction.
      const client = await prisma(pool)
      try {
        await pool.query("INSERT INTO users (name) VALUES ('via-pg')")
        expect(await client.user.count()).toBe(1)

        await client.user.create({ data: { name: 'via-prisma' } })
        const { rows } = await pool.query('SELECT name FROM users ORDER BY name')
        expect(rows.map((r: { name: string }) => r.name)).toEqual(['via-pg', 'via-prisma'])
      } finally {
        // Not $disconnect(): the pool belongs to the application, not to Prisma.
      }
    })

    it('leaves nothing behind from either of those', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
      expect((rows[0] as { n: number }).n).toBe(0)
    })

    it("nests Prisma's interactive transaction inside ours", async () => {
      const client = await prisma(pool)
      await client.$transaction(async (tx) => {
        await tx.user.create({ data: { name: 'inside-tx' } })
        return undefined
      })

      // Prisma's BEGIN/COMMIT became a savepoint pair within the test
      // transaction, so the committed rows are visible here...
      const { rows } = await pool.query('SELECT name FROM users')
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['inside-tx'])
    })

    it('...and that transaction is rolled back with everything else', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
      expect((rows[0] as { n: number }).n).toBe(0)
    })
  })

  describeIntegration('Drizzle', () => {
    it('is isolated', async () => {
      const { drizzle } = await import('drizzle-orm/node-postgres')
      const { integer, pgTable, serial, text } = await import('drizzle-orm/pg-core')

      const users = pgTable('users', {
        id: serial('id').primaryKey(),
        name: text('name').notNull(),
      })
      const orders = pgTable('orders', {
        id: serial('id').primaryKey(),
        userId: integer('user_id').notNull(),
      })
      void orders

      const db = drizzle(pool as never)
      await db.insert(users).values({ name: 'via-drizzle' })

      const { rows } = await pool.query('SELECT name FROM users')
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['via-drizzle'])
    })

    it('and leaves nothing behind either', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
      expect((rows[0] as { n: number }).n).toBe(0)
    })
  })
})
