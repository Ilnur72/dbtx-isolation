import { log } from '../core/log.js'
import { isPatched, patchPg, unpatchPg, type PgModuleLike } from './pg.js'

export {
  EXEMPT,
  exempt,
  hasBegun,
  isExempt,
  isPatched,
  patchPg,
  type PgClientInstance,
  pinnedClients,
  releasePins,
  rollbackClient,
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
 * Load `pg` if the project has it. It is an optional peer dependency, so a
 * missing module is a normal outcome, not an error.
 */
export async function loadPg(): Promise<PgModuleLike | undefined> {
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
