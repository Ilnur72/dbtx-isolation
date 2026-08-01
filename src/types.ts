/**
 * Which isolation strategy a run uses (SPEC §5).
 *
 * - `transaction` — savepoint rollback per test. Fastest, the default.
 * - `database` — real commits, then `TRUNCATE ... RESTART IDENTITY CASCADE`
 *   after each test. Slower, but supports DDL, `LISTEN`/`NOTIFY`, multiple
 *   connections and correct `now()` semantics.
 */
export type Strategy = 'transaction' | 'database'

/** User-supplied configuration, as passed to the Vitest plugin (SPEC §4). */
export interface DbtxConfig {
  /** Connection string for the database the tests should run against. */
  url: string
  /** Isolation strategy. Defaults to `'transaction'`. */
  strategy?: Strategy
  /** Shell command that applies migrations, run once against the template. */
  migrate?: string
  /** Shell command that seeds data, run once against the template. */
  seed?: string
  /**
   * Reset every sequence to 1 before each test so the first inserted row is
   * always `id = 1`. Defaults to `false`.
   */
  resetSequences?: boolean
  /**
   * Prefix for the databases dbtx creates and for the savepoints it emits.
   * Databases matching `<prefix>_*` are considered ours and are safe to drop
   * (see `pruneOrphans`, SPEC §3.6). Defaults to `'dbtx'`.
   */
  prefix?: string
}

/** `DbtxConfig` after defaults have been applied. */
export interface ResolvedDbtxConfig extends DbtxConfig {
  strategy: Strategy
  resetSequences: boolean
  prefix: string
}

/**
 * Something that behaves like a strategy: the object `makeStrategy()` returns.
 * The runner drives these hooks and knows nothing about which strategy it got.
 */
export interface Strategyish {
  readonly name: Strategy
  /** Once per worker, before any test runs. */
  setup(): Promise<void>
  /** Before each test. */
  beforeEach(): Promise<void>
  /** After each test. Must fully await its cleanup (SPEC §3.8). */
  afterEach(): Promise<void>
  /** Once per worker, after the last test. */
  teardown(): Promise<void>
}

/**
 * The parts of a `pg` Client we actually touch. Declared structurally so the
 * core never has to import `pg`, which is an optional peer dependency.
 */
export interface ClientLike {
  query(...args: unknown[]): unknown
  release?(err?: unknown): void
}
