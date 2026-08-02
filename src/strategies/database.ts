import {
  cloneDatabase,
  computeFingerprint,
  createTemplate,
  databaseNameFromUrl,
  dropDatabase,
  dropTemplate,
  openMaintenance,
  pruneOrphans,
  templateName,
  urlForDatabase,
  withAdmin,
  workerDatabaseName,
  type AdminClient,
} from '../admin.js'
import { DEFAULT_EXCLUDED_TABLES } from '../core/config.js'
import { newCtx, nextCtxId, setAmbient } from '../core/context.js'
import { log, warn } from '../core/log.js'
import { isPatched, loadPg } from '../drivers/index.js'
import type { GlobalData, ResolvedConfig, Strategy, WorkerContext } from '../types.js'

/** `LIKE`-style exclusion pattern (`%` is a wildcard) to a matcher. */
function toMatcher(pattern: string): RegExp {
  const source = pattern
    .split('%')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * Decide which tables may be emptied. Truncating an ORM's migration table
 * makes it believe no migration has ever run, so the built-in bookkeeping
 * names are always excluded, plus whatever the user added. Patterns match
 * either the bare name or `schema.name`.
 */
export function makeTableFilter(extra: readonly string[] = []): (
  schema: string,
  name: string,
) => boolean {
  const matchers = [...DEFAULT_EXCLUDED_TABLES, ...extra].map(toMatcher)
  return (schema, name) =>
    !matchers.some((matcher) => matcher.test(name) || matcher.test(`${schema}.${name}`))
}

/**
 * Real commits, with the database emptied between tests (SPEC §5).
 *
 * Slower than `transaction`, but it supports DDL, `LISTEN`/`NOTIFY`, several
 * connections at once and correct `now()` semantics — because there is no
 * outer transaction to distort any of that.
 *
 * v0.1 does not replay the seed after truncation. Whatever the seed inserted
 * is gone after the first test.
 */
export function createDatabaseStrategy(config: ResolvedConfig): Strategy {
  let maintenance: AdminClient | undefined
  let truncatable: string[] | undefined
  let workerDatabase: string | undefined

  const shouldTruncate = makeTableFilter(config.excludeTables)

  /**
   * The tables to empty, looked up once per worker. Asking for this on every
   * test would add a catalogue query to each one.
   */
  async function tables(client: AdminClient): Promise<string[]> {
    if (truncatable !== undefined) return truncatable

    const rows = await client.query(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              format('%I.%I', n.nspname, c.relname) AS qualified
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%' ESCAPE '\\'
          AND n.nspname NOT LIKE 'pg\\_temp%' ESCAPE '\\'`,
    )

    const kept: string[] = []
    const skipped: string[] = []
    for (const row of rows) {
      const schema = String(row['schema'])
      const name = String(row['name'])
      const qualified = String(row['qualified'])
      if (shouldTruncate(schema, name)) kept.push(qualified)
      else skipped.push(qualified)
    }

    truncatable = kept
    log(`truncating ${kept.length} table(s); leaving ${skipped.length} alone`)
    if (skipped.length > 0) log('excluded:', skipped.join(', '))
    return truncatable
  }

  function fingerprintOf(worker: WorkerContext): string {
    const fingerprint = worker.global.fingerprint
    if (fingerprint === undefined) {
      throw new Error(
        "dbtx: the worker did not receive the run's template fingerprint. globalSetup has " +
          'to run before the workers; check that the dbtx plugin is in your vitest config.',
      )
    }
    return fingerprint
  }

  return {
    name: 'database',

    async globalSetup(): Promise<GlobalData> {
      // Leftovers from crashed runs, before anything else (SPEC §3.6).
      await pruneOrphans({
        url: config.url,
        prefix: config.prefix,
        maintenanceDatabase: config.maintenanceDatabase,
      })

      const fingerprint = await computeFingerprint({
        url: config.url,
        migrate: config.migrate,
        seed: config.seed,
        cacheTemplate: config.cacheTemplate,
      })

      const { name, reused } = await createTemplate({
        url: config.url,
        prefix: config.prefix,
        fingerprint,
        migrate: config.migrate,
        seed: config.seed,
        cache: config.cacheTemplate !== undefined,
        maintenanceDatabase: config.maintenanceDatabase,
      })
      log(reused ? 'reused template' : 'built template', name)

      return { url: config.url, template: name, fingerprint }
    },

    async globalTeardown(data: GlobalData): Promise<void> {
      if (config.keepDatabases) {
        warn(`dbtx: keepDatabases is on, so ${config.prefix}_* databases are being left behind.`)
        return
      }
      const fingerprint = data.fingerprint ?? ''
      const template = data.template ?? templateName(config.prefix, fingerprint)
      const cached = config.cacheTemplate !== undefined

      // Worker databases first; a worker that crashed never dropped its own.
      // Their connections are ours and the run is over, so taking them is safe.
      await pruneOrphans({
        url: config.url,
        prefix: config.prefix,
        maintenanceDatabase: config.maintenanceDatabase,
        includeActive: true,
        keep: cached ? [template] : [],
      })

      if (!cached && fingerprint !== '') {
        await dropTemplate({
          url: config.url,
          prefix: config.prefix,
          fingerprint,
          maintenanceDatabase: config.maintenanceDatabase,
        })
      }
    },

    /**
     * This strategy deliberately does not patch anything: real commits are the
     * point. If the driver is patched, something has gone wrong — a leftover
     * patch would wrap these tests in a transaction and take away exactly the
     * behaviour they chose this strategy for.
     */
    async setup(worker: WorkerContext): Promise<void> {
      const pg = await loadPg()
      if (pg !== undefined && isPatched(pg)) {
        throw new Error(
          "dbtx: the pg driver is patched, but strategy: 'database' must run against an " +
            'unpatched driver. Are two dbtx setups active at once?',
        )
      }

      const template = worker.global.template
      if (template === undefined) {
        throw new Error('dbtx: no template database was produced by globalSetup.')
      }

      workerDatabase = workerDatabaseName(config.prefix, fingerprintOf(worker), worker.poolId)
      await cloneDatabase({
        url: config.url,
        prefix: config.prefix,
        template,
        database: workerDatabase,
        maintenanceDatabase: config.maintenanceDatabase,
      })

      const workerUrl = urlForDatabase(config.url, workerDatabase)
      // The application under test reads its connection string from the
      // environment, so this is what points it at this worker's own database.
      process.env['DATABASE_URL'] = workerUrl
      maintenance = await openMaintenance(workerUrl)
      log(`worker ${worker.poolId} is using ${workerDatabase}`)
    },

    async beforeEach(): Promise<void> {
      // No interception happens here; the context exists so `dbtx.isolated`
      // and `dbtx.uncommitted` behave the same under both strategies.
      setAmbient(newCtx(nextCtxId(config.prefix)))
    },

    async afterEach(): Promise<void> {
      try {
        if (maintenance === undefined) return
        const names = await tables(maintenance)
        if (names.length === 0) return
        // One statement: TRUNCATE takes every table at once, and RESTART
        // IDENTITY resets their sequences in the same breath.
        await maintenance.query(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`)
      } finally {
        setAmbient(undefined)
      }
    },

    async teardown(_worker: WorkerContext): Promise<void> {
      if (maintenance !== undefined) {
        await maintenance.end().catch((err: unknown) => {
          log('closing the maintenance connection failed:', err)
        })
        maintenance = undefined
      }
      truncatable = undefined

      if (workerDatabase === undefined || config.keepDatabases) return
      const database = workerDatabase
      workerDatabase = undefined
      await withAdmin(
        { url: config.url, maintenanceDatabase: config.maintenanceDatabase },
        (admin) =>
          dropDatabase(admin, database, {
            prefix: config.prefix,
            applicationDatabase: databaseNameFromUrl(config.url),
          }),
      ).catch((err: unknown) => {
        warn(`could not drop the worker database ${database}:`, err)
      })
    },
  }
}
