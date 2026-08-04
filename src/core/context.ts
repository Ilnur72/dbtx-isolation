import { AsyncLocalStorage } from 'node:async_hooks'
import type { ClientLike } from '../types.js'
import { assertIdentifierFits, assertValidPrefix, DEFAULT_PREFIX } from './config.js'

/**
 * Per-test state (SPEC §3.4).
 *
 * `depth` is mutated by `rewrite()` as the ORM's own `BEGIN`/`COMMIT`
 * statements are turned into savepoints, and `clients` collects every client
 * that has been made to open the test transaction so `afterEach` can roll each
 * one back.
 */
export interface TestCtx {
  /** Unique per test; prefixes every savepoint name this context emits. */
  id: string
  /** Nesting level of the ORM's own transactions inside this test. */
  depth: number
  /** False once the test has finished tearing down. */
  active: boolean
  /** While true, statements pass through untouched (`dbtx.uncommitted`). */
  bypass: boolean
  /** Clients that have an open test transaction and must be rolled back. */
  clients: Set<ClientLike>
  /**
   * Errors that happened out of band — a lazy `BEGIN` that was enqueued but
   * failed, say. Nobody is awaiting those promises, so without this they would
   * surface as an unhandled rejection, or not at all. `afterEach` reports them.
   */
  failures: unknown[]
  /**
   * How many statements dbtx actually saw in this test. Zero at the end of a
   * test that ran queries means the patch never took effect — typically dbtx
   * patched a different copy of `pg` than the application imported.
   */
  intercepted: number
}

/**
 * Contexts propagate through `AsyncLocalStorage`, but Vitest runs
 * `beforeEach`/`afterEach` outside the test body's ALS chain, so a
 * module-level `ambient` context is kept as a fallback. A plain global counter
 * would not be safe under parallelism (SPEC §3.4).
 */
export const als = new AsyncLocalStorage<TestCtx>()

let ambient: TestCtx | undefined
let counter = 0

/**
 * Build the next context id: `<prefix>_<poolId>_<n>`.
 *
 * Savepoint names are derived from this (`"<ctxId>_sp_<depth>"`), so the id is
 * checked against the Postgres identifier limit with room left for the
 * `_sp_<depth>` suffix. `VITEST_POOL_ID` is bounded by `maxWorkers`, unlike
 * `VITEST_WORKER_ID` (SPEC §3.5), which keeps the name short.
 */
export function nextCtxId(prefix: string = DEFAULT_PREFIX): string {
  assertValidPrefix(prefix)
  const pool = process.env['VITEST_POOL_ID'] ?? '0'
  const id = `${prefix}_${pool}_${++counter}`
  // Reserve `_sp_` plus a generous depth for the savepoint suffix.
  assertIdentifierFits(`${id}_sp_999999`)
  return id
}

/** Create a fresh, active context. */
export function newCtx(id: string = nextCtxId()): TestCtx {
  return {
    id,
    depth: 0,
    active: true,
    bypass: false,
    clients: new Set(),
    failures: [],
    intercepted: 0,
  }
}

/**
 * Record an error that nothing is awaiting, so `afterEach` can surface it
 * instead of letting it become an unhandled rejection.
 */
export function recordFailure(ctx: TestCtx, err: unknown): void {
  ctx.failures.push(err)
}

/** Take and clear the recorded out-of-band errors. */
export function takeFailures(ctx: TestCtx): unknown[] {
  return ctx.failures.splice(0, ctx.failures.length)
}

/** The context for the current test, if any. ALS first, then the fallback. */
export function getCtx(): TestCtx | undefined {
  return als.getStore() ?? ambient
}

/** The current context, but only when it is usable for interception. */
export function activeCtx(): TestCtx | undefined {
  const ctx = getCtx()
  return ctx !== undefined && ctx.active && !ctx.bypass ? ctx : undefined
}

/** Install the fallback context used by hooks that run outside the ALS chain. */
export function setAmbient(ctx: TestCtx | undefined): void {
  ambient = ctx
}

/** The fallback context, if one is installed. */
export function getAmbient(): TestCtx | undefined {
  return ambient
}

/** Run `fn` with `ctx` bound to the ALS chain. */
export function runWith<T>(ctx: TestCtx, fn: () => T): T {
  return als.run(ctx, fn)
}

/**
 * Run `fn` with interception disabled, restoring the *previous* bypass state
 * afterwards rather than assuming it was false (SPEC §7, criterion 13).
 *
 * With no active context this is just `fn()`.
 */
export function withBypass<T>(fn: () => T | Promise<T>): Promise<T> {
  const ctx = getCtx()
  if (ctx === undefined) return Promise.resolve().then(fn)

  const previous = ctx.bypass
  ctx.bypass = true
  const restore = (): void => {
    ctx.bypass = previous
  }

  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        restore()
        return value
      },
      (err: unknown) => {
        restore()
        throw err
      },
    )
}
