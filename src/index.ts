import { getCtx, withBypass } from './core/context.js'

export { useDriver } from './drivers/index.js'

export type {
  ClientLike,
  DbtxConfig,
  GlobalData,
  ResolvedConfig,
  Strategy,
  StrategyName,
  WorkerContext,
} from './types.js'

/**
 * The public API (SPEC §4).
 *
 * ```ts
 * import { dbtx } from 'dbtx-isolation'
 *
 * await dbtx.uncommitted(async () => {
 *   await pool.query('CREATE TABLE scratch (id int)')  // survives the test
 * })
 * ```
 */
export const dbtx = {
  /**
   * Run `fn` outside the test's isolation, so what it writes is really
   * committed. For the things a test transaction cannot contain: DDL that must
   * persist, `LISTEN`/`NOTIFY`, work another connection has to see.
   *
   * Whatever it writes is yours to clean up — that is what escaping means.
   * The previous bypass state is restored afterwards, so nesting behaves
   * (SPEC §7, criterion 13).
   */
  uncommitted<T>(fn: () => T | Promise<T>): Promise<T> {
    return withBypass(fn)
  },

  /** Whether statements are currently being isolated. */
  get isolated(): boolean {
    const ctx = getCtx()
    return ctx !== undefined && ctx.active && !ctx.bypass
  },

  /** How deep the application's own transactions are nested, for debugging. */
  get depth(): number {
    return getCtx()?.depth ?? 0
  },
}
