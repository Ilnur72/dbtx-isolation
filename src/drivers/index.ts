import { createRequire } from 'node:module'
import { join } from 'node:path'
import { log, warn } from '../core/log.js'
import { isPatched, patchPg, unpatchPg, type PgModuleLike } from './pg.js'

export {
  checkIsolation,
  DbtxRollbackTimeoutError,
  EXEMPT,
  exempt,
  hasBegun,
  isExempt,
  isolationBreach,
  isPatched,
  patchPg,
  type PgClientInstance,
  pinnedClients,
  releasePins,
  rollbackClient,
  transactionStatus,
  unexempt,
  unpatchPg,
  type PgClient,
  type PgModuleLike,
  type PgPool,
} from './pg.js'

/** Names of the drivers dbtx knows how to patch. v0.1 is `pg` only (SPEC §1). */
export type DriverName = 'pg'

function looksLikePg(mod: unknown): mod is PgModuleLike {
  if (typeof mod !== 'object' || mod === null) return false
  const candidate = mod as { Client?: { prototype?: unknown }; Pool?: { prototype?: unknown } }
  return (
    typeof candidate.Client === 'function' &&
    typeof candidate.Pool === 'function' &&
    typeof (candidate.Client.prototype as { query?: unknown } | undefined)?.query === 'function' &&
    typeof (candidate.Pool.prototype as { connect?: unknown } | undefined)?.connect === 'function'
  )
}

/**
 * The `pg` module the user handed us explicitly. This is the primary path and
 * the one the README recommends: there is nothing to resolve, nothing to
 * guess, and no way for dbtx to patch a different copy than the application
 * imports.
 */
let injected: PgModuleLike | undefined

/**
 * Tell dbtx which `pg` your application uses.
 *
 * ```ts
 * // test/dbtx-driver.ts, listed in setupFiles
 * import pg from 'pg'
 * import { useDriver } from 'dbtx-isolation'
 * useDriver(pg)
 * ```
 */
export function useDriver(pg: unknown): void {
  // `pg` may arrive as the module namespace, whose CommonJS body sits on
  // `default`. Anything else has to survive this line without throwing, so
  // that the error below is the one the user sees.
  const candidate =
    typeof pg === 'object' && pg !== null ? ((pg as { default?: unknown }).default ?? pg) : pg
  if (!looksLikePg(candidate)) {
    throw new Error(
      'dbtx: useDriver() was given something that is not the `pg` module. Pass the module ' +
        "itself — `import pg from 'pg'; useDriver(pg)`.",
    )
  }
  injected = candidate
  log('using an explicitly provided pg module')
}

/** The explicitly provided module, if there is one. */
export function injectedDriver(): PgModuleLike | undefined {
  return injected
}

/** Forget the explicitly provided module. For tests. */
export function clearDriver(): void {
  injected = undefined
}

/**
 * Load `pg` if the project has it. It is an optional peer dependency, so a
 * missing module is a normal outcome, not an error.
 */
export async function loadPg(): Promise<PgModuleLike | undefined> {
  if (injected !== undefined) return injected
  let mod: unknown
  try {
    mod = await import('pg')
  } catch (err) {
    log('pg is not installed:', err)
    return undefined
  }
  // pg is CommonJS, so under ESM the module itself arrives on `default`.
  const candidate = (mod as { default?: unknown }).default ?? mod
  if (looksLikePg(candidate)) return candidate
  if (looksLikePg(mod)) return mod
  log('pg resolved but does not look like the module we expect; leaving it alone')
  return undefined
}

/**
 * Like {@link loadPg}, but for callers that cannot work without it — the
 * template and clone machinery in `admin.ts`, for instance.
 */
export async function loadPgOrThrow(): Promise<PgModuleLike> {
  const pg = await loadPg()
  if (pg === undefined) {
    throw new Error(
      'dbtx: this needs the `pg` package, which is an optional peer dependency. ' +
        'Install it with `npm install --save-dev pg`.',
    )
  }
  return pg
}

/**
 * Patch every driver present in the project. Safe to call more than once —
 * each driver's own patch is idempotent.
 */
export async function patchDetectedDrivers(): Promise<DriverName[]> {
  const patched: DriverName[] = []
  const pg = await loadPg()
  if (pg !== undefined) {
    patchPg(pg)
    if (isPatched(pg)) patched.push('pg')
  }
  log('patched drivers:', patched.length === 0 ? '(none)' : patched.join(', '))
  return patched
}

/** Undo {@link patchDetectedDrivers}. */
export async function unpatchDetectedDrivers(): Promise<DriverName[]> {
  const unpatched: DriverName[] = []
  const pg = await loadPg()
  if (pg !== undefined && unpatchPg(pg)) unpatched.push('pg')
  return unpatched
}

/** What {@link verifyDriverIdentity} concluded. */
export type DriverIdentity =
  | { status: 'injected' }
  | { status: 'match'; path: string }
  | { status: 'mismatch'; ours: string; theirs: string }
  | { status: 'unknown'; reason: string }

/**
 * Check that the `pg` dbtx patches is the same copy the application imports.
 *
 * This is the direct answer to the failure that has no symptom: if the two
 * differ, every patch lands on a module nobody uses, no statement is ever
 * intercepted, and every test passes while nothing is isolated. Comparing the
 * resolved paths says so outright, instead of leaving it to be inferred from
 * a suspiciously quiet test run.
 */
export function verifyDriverIdentity(cwd: string = process.cwd()): DriverIdentity {
  if (injected !== undefined) return { status: 'injected' }

  let ours: string
  try {
    ours = createRequire(import.meta.url).resolve('pg')
  } catch (err) {
    return { status: 'unknown', reason: `dbtx cannot resolve pg itself: ${String(err)}` }
  }

  let theirs: string
  try {
    // Resolved the way the application would, from the project root.
    theirs = createRequire(join(cwd, 'package.json')).resolve('pg')
  } catch (err) {
    return {
      status: 'unknown',
      reason: `pg does not resolve from ${cwd}: ${String(err)}`,
    }
  }

  return ours === theirs ? { status: 'match', path: ours } : { status: 'mismatch', ours, theirs }
}

/**
 * Turn {@link verifyDriverIdentity} into an outcome.
 *
 * A mismatch is always fatal: it is a definite answer, and continuing would
 * mean running a suite that silently isolates nothing. Being unable to tell is
 * a different thing — it warns, and only `strict` makes it fatal.
 */
export function assertDriverIdentity(options: { strict: boolean; cwd?: string } = { strict: false }): DriverIdentity {
  const identity = verifyDriverIdentity(options.cwd)

  if (identity.status === 'mismatch') {
    throw new Error(
      'dbtx: the `pg` dbtx would patch is not the one your application imports, so nothing ' +
        `would be isolated.\n  dbtx resolves:        ${identity.ours}\n  your project resolves: ` +
        `${identity.theirs}\n` +
        "Pass your copy explicitly — import pg from 'pg'; useDriver(pg) — in a setup file, " +
        'or install a single copy of pg.',
    )
  }

  if (identity.status === 'unknown') {
    const message =
      `dbtx: could not confirm that it patches the same pg your application uses. ` +
      `${identity.reason}. Pass it explicitly with useDriver(pg) to remove the doubt.`
    if (options.strict) throw new Error(message)
    warn(message)
  }

  return identity
}
