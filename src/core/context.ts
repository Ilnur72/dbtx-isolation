import { AsyncLocalStorage } from 'node:async_hooks'
import type { ClientLike } from '../types.js'

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

/** Create a fresh, active context. */
export function newCtx(id?: string): TestCtx {
  const pool = process.env['VITEST_POOL_ID'] ?? '0'
  return {
    id: id ?? `dbtx_${pool}_${++counter}`,
    depth: 0,
    active: true,
    bypass: false,
    clients: new Set(),
  }
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
