import { afterEach, beforeEach, inject } from 'vitest'
import { log } from '../core/log.js'
import { assertDriverIdentity } from '../drivers/index.js'
import { makeStrategy } from '../strategies/index.js'
import type { Strategy, WorkerContext } from '../types.js'
import './vitest.js' // brings the ProvidedContext declarations with it

/**
 * Per-worker state, parked on `globalThis` rather than in module scope.
 *
 * Vitest re-evaluates setup files for every test file, so module scope would
 * mean patching the driver and cloning a database once per file. `globalThis`
 * survives that whenever the worker process is reused.
 */
const WORKER = Symbol.for('dbtx.worker')

interface WorkerState {
  strategy: Strategy
  worker: WorkerContext
}

/**
 * `VITEST_POOL_ID` is bounded between 1 and `maxWorkers`, unlike
 * `VITEST_WORKER_ID`, which climbs without limit and would produce one
 * database per test file (SPEC §3.5).
 */
function poolId(): number {
  const raw = Number.parseInt(process.env['VITEST_POOL_ID'] ?? '1', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

async function start(): Promise<WorkerState> {
  const config = inject('dbtx:config')
  const global = inject('dbtx:global')

  // Before anything is patched: is the pg we are about to patch the one the
  // application imports? A mismatch is fatal here, because every test would
  // otherwise pass while nothing at all was isolated.
  assertDriverIdentity({ strict: config.strict })

  const strategy = makeStrategy(config.strategy, config)
  const worker: WorkerContext = { poolId: poolId(), url: config.url, global }
  await strategy.setup(worker)

  // Best effort: Vitest tears workers down on its own schedule, and the
  // database strategy's globalTeardown prunes any worker database this misses.
  process.once('beforeExit', () => {
    void strategy.teardown(worker).catch((err: unknown) => {
      log('worker teardown failed:', err)
    })
  })

  log(`worker ${worker.poolId} ready with the ${strategy.name} strategy`)
  return { strategy, worker }
}

const store = globalThis as unknown as Record<symbol, Promise<WorkerState> | undefined>

/*
 * Awaited at the top level, on purpose. Setup files finish before the test file
 * is imported, so anything the strategy needs to arrange first — patching the
 * driver, pointing DATABASE_URL at this worker's own database — is already
 * done by the time application modules run and start building pools. A
 * `beforeAll` would be too late for a pool created at import time.
 */
const { strategy } = await (store[WORKER] ??= start())

beforeEach(async () => {
  await strategy.beforeEach()
})

afterEach(async () => {
  await strategy.afterEach()
})
