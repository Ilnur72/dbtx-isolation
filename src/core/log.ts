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

/**
 * Write a debug line. Goes to stderr so it never mixes into a reporter's
 * stdout stream.
 */
export function log(...args: unknown[]): void {
  if (!debugEnabled()) return
  const pool = process.env['VITEST_POOL_ID']
  const tag = pool === undefined ? '[dbtx]' : `[dbtx:${pool}]`
  console.error(tag, ...args)
}
