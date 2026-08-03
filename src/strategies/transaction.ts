import { databaseNameFromUrl, openMaintenance, type AdminClient } from '../admin.js'
import { getAmbient, newCtx, nextCtxId, setAmbient, takeFailures } from '../core/context.js'
import { log } from '../core/log.js'
import {
  checkIsolation,
  patchDetectedDrivers,
  releasePins,
  rollbackClient,
  unpatchDetectedDrivers,
} from '../drivers/index.js'
import type { ResolvedConfig, Strategy, WorkerContext } from '../types.js'

/** How long a single client's ROLLBACK may take before we give up on it. */
const ROLLBACK_TIMEOUT_MS = 10_000

function combine(errors: unknown[]): unknown {
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, `dbtx: ${errors.length} problems while ending the test`)
}

/**
 * Savepoint rollback per test (SPEC §5). Nothing is ever committed, so there
 * is no run-level work to do: no template, no clones, no `globalSetup`.
 */
export function createTransactionStrategy(config: ResolvedConfig): Strategy {
  /** Long-lived exempt connection, only opened when sequences need resetting. */
  let maintenance: AdminClient | undefined
  let sequences: string[] | undefined

  async function sequenceNames(client: AdminClient): Promise<string[]> {
    if (sequences !== undefined) return sequences
    const rows = await client.query(
      `SELECT format('%I.%I', schemaname, sequencename) AS name
         FROM pg_sequences
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    )
    sequences = rows.map((row) => String(row['name']))
    log(`sequence reset covers ${sequences.length} sequence(s)`)
    return sequences
  }

  /**
   * `setval` is not transactional, so this survives the rollback at the end of
   * the test — which is the whole point, and why it runs on an exempt
   * connection that never joins the test transaction (SPEC §3.7).
   */
  async function resetSequences(): Promise<void> {
    if (maintenance === undefined) return
    const names = await sequenceNames(maintenance)
    if (names.length === 0) return
    const calls = names
      .map((name) => `setval('${name.replace(/'/g, "''")}', 1, false)`)
      .join(', ')
    await maintenance.query(`SELECT ${calls}`)
  }

  return {
    name: 'transaction',

    async setup(worker: WorkerContext): Promise<void> {
      const patched = await patchDetectedDrivers()
      if (patched.length === 0) {
        throw new Error(
          'dbtx: no supported database driver was found to patch. v0.1 supports `pg`; ' +
            'install it, or point dbtx at the copy your application uses.',
        )
      }
      if (config.resetSequences) {
        assertSequencesCanBeReset(worker)
        maintenance = await openMaintenance(config.url, databaseNameFromUrl(config.url))
      }
    },

    async beforeEach(): Promise<void> {
      const ctx = newCtx(nextCtxId(config.prefix))
      // Vitest runs hooks outside the test body's ALS chain, so the context is
      // installed as the module-level fallback (SPEC §3.4).
      setAmbient(ctx)
      if (config.resetSequences) await resetSequences()
    },

    /**
     * Undo everything the test did, and say so plainly when that failed.
     *
     * Runs whether the test passed or threw. dbtx registers its hooks from a
     * setup file, and Vitest runs `afterEach` hooks in reverse registration
     * order, so this one runs last — after the user's own cleanup, which
     * therefore still happens inside the test transaction and is rolled back
     * with everything else.
     *
     * The rollback is fully awaited before returning (SPEC §3.8): a
     * fire-and-forget rollback is exactly the flakiness this library exists to
     * avoid.
     */
    async afterEach(): Promise<void> {
      const ctx = getAmbient()
      if (ctx === undefined) return

      const errors: unknown[] = takeFailures(ctx)
      try {
        // Stop intercepting before the teardown statements go out.
        ctx.active = false

        // Ask the backend, not our own bookkeeping, whether the transaction is
        // still open — before rolling back, while the answer still means
        // something. 'I' here means something committed it and the test's rows
        // are already permanent. Each check costs one round trip, which is
        // what makes the answer trustworthy; see checkIsolation.
        for (const client of ctx.clients) {
          const breach = await checkIsolation(client)
          if (breach !== undefined) errors.push(breach)
        }

        // A test may have opened several pools or clients; each has its own
        // pinned connection and its own transaction to undo.
        for (const client of ctx.clients) {
          const failure = await rollbackClient(client, { timeoutMs: ROLLBACK_TIMEOUT_MS })
          if (failure !== undefined) errors.push(failure)
        }
        ctx.clients.clear()

        // Only now may the pinned connections go back to their pools.
        await releasePins()

        if (ctx.intercepted === 0) {
          // Diagnostic only. Zero statements is an *indirect* hint that dbtx
          // patched a different copy of `pg` than the application imports —
          // but a test that simply does not touch the database looks exactly
          // the same, and Vitest can hand a worker nothing but unit tests. The
          // direct check (comparing the resolved module paths) belongs to the
          // runner, and that is what `strict` is wired to.
          log('no statements passed through dbtx in this test')
        }
      } finally {
        setAmbient(undefined)
      }

      if (errors.length > 0) throw combine(errors)
    },

    async teardown(_worker: WorkerContext): Promise<void> {
      await releasePins()
      if (maintenance !== undefined) {
        await maintenance.end().catch((err: unknown) => {
          log('closing the maintenance connection failed:', err)
        })
        maintenance = undefined
      }
      sequences = undefined
      await unpatchDetectedDrivers()
    },
  }
}

/**
 * `resetSequences` cannot hold under this strategy once more than one worker
 * is running.
 *
 * Every worker shares the one database here — the transaction strategy creates
 * none of its own — and a sequence is neither transactional nor per-session.
 * So one worker setting a sequence back to 1 lands in the middle of another
 * worker's test, and both get ids they did not expect. The guarantee is not
 * weakened by parallelism, it is gone, so this refuses rather than producing
 * an id that is right most of the time.
 *
 * `VITEST_POOL_ID` above 1 is proof that a second worker exists; with a single
 * worker it is always 1 and nothing is raised (SPEC §3.5).
 */
function assertSequencesCanBeReset(worker: WorkerContext): void {
  if (worker.poolId <= 1) return
  throw new Error(
    "dbtx: resetSequences cannot work with strategy: 'transaction' across several workers. " +
      'Every worker shares one database, and sequences are not transactional, so a reset in ' +
      "one worker changes the ids another worker is about to get.\nEither give each worker " +
      "its own database with strategy: 'database', or run the files one at a time " +
      '(`fileParallelism: false`, or `poolOptions: { forks: { singleFork: true } }`), or turn ' +
      'resetSequences off.',
  )
}
