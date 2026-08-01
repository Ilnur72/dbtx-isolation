/*
 * Types only. Nothing in this file emits runtime code, so every module can
 * reach it with `import type` and no import edge is created — which keeps
 * admin.ts, the drivers and the strategies free of cycles. Config defaults and
 * validation live in `core/config.ts`.
 */

/**
 * Which isolation strategy a run uses (SPEC §5).
 *
 * - `transaction` — savepoint rollback per test. Fastest, the default.
 * - `database` — real commits, then `TRUNCATE ... RESTART IDENTITY CASCADE`
 *   after each test. Slower, but supports DDL, `LISTEN`/`NOTIFY`, multiple
 *   connections and correct `now()` semantics.
 */
export type StrategyName = 'transaction' | 'database'

/** User-supplied configuration, as passed to the Vitest plugin (SPEC §4). */
export interface DbtxConfig {
  /** Connection string for the database the tests should run against. */
  url: string
  /** Isolation strategy. Defaults to `'transaction'`. */
  strategy?: StrategyName
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
   * Turn dbtx's warnings into errors — most importantly a test that finished
   * without a single intercepted query, which usually means dbtx patched a
   * different copy of `pg` than the application uses. Defaults to `false`.
   */
  strict?: boolean
  /**
   * Prefix for the identifiers dbtx creates: the `<prefix>_*` databases it
   * clones and drops (SPEC §3.6) and the savepoints it emits (SPEC §3.2).
   * Must match `PREFIX_PATTERN` in `core/config.ts`. Defaults to `'dbtx'`.
   */
  prefix?: string
}

/** `DbtxConfig` once defaults have been applied and validation has run. */
export interface ResolvedConfig extends DbtxConfig {
  strategy: StrategyName
  resetSequences: boolean
  strict: boolean
  prefix: string
}

/** Whatever `globalSetup` produced, handed back to `globalTeardown` and to
 * each worker through Vitest's `provide`/`inject`. */
export interface GlobalData {
  /** Name of the template database created for this run, if any. */
  template?: string
  /** The URL the run was configured with. */
  url: string
}

/** What a single Vitest worker needs to know about the run. */
export interface WorkerContext {
  /** `VITEST_POOL_ID`, bounded by `maxWorkers` (SPEC §3.5). */
  poolId: number
  /** Data produced once per run by `globalSetup`. */
  global: GlobalData
  /** The database URL this worker's tests should connect to. */
  url: string
}

/**
 * The lifecycle a strategy implements. The runner drives these and knows
 * nothing about which strategy it got.
 *
 * The split matters: creating the template database is a whole-run job that
 * has to happen in `globalSetup`, before workers exist, while cloning it is
 * per-worker. The `transaction` strategy does not implement the global hooks
 * at all.
 */
export interface Strategy {
  readonly name: StrategyName
  /** Once per run, before any worker starts. */
  globalSetup?(): Promise<GlobalData>
  /** Once per run, after every worker has finished. */
  globalTeardown?(data: GlobalData): Promise<void>
  /** Once per worker, before any test in it runs. */
  setup(worker: WorkerContext): Promise<void>
  /** Before each test. */
  beforeEach(): Promise<void>
  /** After each test. Must fully await its cleanup (SPEC §3.8). */
  afterEach(): Promise<void>
  /** Once per worker, after its last test. */
  teardown(worker: WorkerContext): Promise<void>
}

/**
 * The parts of a `pg` Client we actually touch. Declared structurally so the
 * core never has to import `pg`, which is an optional peer dependency.
 */
export interface ClientLike {
  query(...args: unknown[]): unknown
  release?(err?: unknown): void
}
