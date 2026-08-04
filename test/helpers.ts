import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, Query } from 'pg'
import { describe } from 'vitest'
import { openMaintenance, urlForDatabase } from '../src/admin.js'
import type { WorkerContext } from '../src/types.js'

/** The bits of `pg` the integration tests construct directly. */
export interface PgApi {
  Pool: new (config: { connectionString: string; max?: number }) => Pool
  Query: new (text: string, values?: unknown[]) => Query
}

/**
 * `pg` is CommonJS, so under ESM the module object arrives on `default`. The
 * tests go through this rather than a named import, which cjs-module-lexer
 * cannot resolve for pg's dynamically built exports.
 */
export async function pgApi(): Promise<PgApi> {
  const mod = await import('pg')
  const candidate = (mod as unknown as { default?: unknown }).default ?? mod
  return candidate as PgApi
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the integration tests run. Absent means "skip" — unless
 * `DBTX_INTEGRATION=1`, which means someone believes these tests are running
 * and wants to be told the truth if they are not.
 */
export const DATABASE_URL = process.env['DATABASE_URL']

const REQUIRED = process.env['DBTX_INTEGRATION'] === '1'

if (REQUIRED && (DATABASE_URL === undefined || DATABASE_URL === '')) {
  throw new Error(
    'dbtx tests: DBTX_INTEGRATION=1 was set but DATABASE_URL is not. Refusing to skip the ' +
      'integration suite silently — a green run that checked nothing is worse than a red one.',
  )
}

/**
 * `describe` for tests that need a real Postgres. Skips without a
 * `DATABASE_URL`; the guard above makes that impossible to do by accident in
 * CI.
 */
export const describeIntegration: typeof describe | typeof describe.skip =
  DATABASE_URL === undefined || DATABASE_URL === '' ? describe.skip : describe

/** The URL, asserted to exist. Only call inside {@link describeIntegration}. */
export function url(): string {
  if (DATABASE_URL === undefined) throw new Error('DATABASE_URL is not set')
  return DATABASE_URL
}

/** A `WorkerContext` as the runner would build one (SPEC §3.5). */
export function workerContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    poolId: 1,
    url: url(),
    global: { url: url() },
    ...overrides,
  }
}

/**
 * Apply `schema.sql` to a database, on an exempt connection so none of it is
 * rewritten or wrapped in a test transaction.
 */
export async function applySchema(targetUrl: string = url()): Promise<void> {
  const sql = await readFile(join(HERE, 'schema.sql'), 'utf8')
  const client = await openMaintenance(targetUrl)
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** Run one statement on an exempt connection, outside any test transaction. */
export async function outsideTest<T = Array<Record<string, unknown>>>(
  sql: string,
  values?: unknown[],
  targetUrl: string = url(),
): Promise<T> {
  const client = await openMaintenance(targetUrl)
  try {
    return (await client.query(sql, values)) as T
  } finally {
    await client.end()
  }
}

/** Same server, different database. */
export function otherDatabase(name: string): string {
  return urlForDatabase(url(), name)
}

/** Wait for a condition, so tests never depend on a fixed sleep. */
export async function until(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('dbtx tests: condition was never met')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
