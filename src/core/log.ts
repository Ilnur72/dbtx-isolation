/**
 * Debug logging, gated on `DBTX_DEBUG`.
 *
 * The env var is read on every call rather than cached at import time, so a
 * test can flip it on for a single assertion.
 */

/** True unless `DBTX_DEBUG` is unset, empty, `0`, `false` or `off`. */
export function debugEnabled(): boolean {
  const raw = process.env['DBTX_DEBUG']
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off'
}

function tag(): string {
  const pool = process.env['VITEST_POOL_ID']
  return pool === undefined ? '[dbtx]' : `[dbtx:${pool}]`
}

/**
 * Write a debug line. Goes to stderr so it never mixes into a reporter's
 * stdout stream.
 */
export function log(...args: unknown[]): void {
  if (!debugEnabled()) return
  console.error(tag(), ...args)
}

/**
 * Report something the user needs to know about even when debugging is off —
 * a rollback that failed, say. Silence there would leave a broken test
 * impossible to diagnose.
 */
export function warn(...args: unknown[]): void {
  console.error(tag(), ...args)
}
