import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../core/config.js'
import type { DbtxConfig, GlobalData, ResolvedConfig } from '../types.js'

/**
 * What dbtx passes to the workers through Vitest's `provide`/`inject`
 * (SPEC §4). Both values are plain JSON — a module instance could never
 * survive the trip, which is why explicit driver injection happens in a setup
 * file instead (`useDriver`).
 */
declare module 'vitest' {
  interface ProvidedContext {
    'dbtx:config': ResolvedConfig
    'dbtx:global': GlobalData
  }
}

/** The parts of the user's Vitest config this plugin reads. */
export interface UserConfigLike {
  test?: {
    fileParallelism?: boolean
    maxWorkers?: number | string
    poolOptions?: {
      forks?: { singleFork?: boolean }
      threads?: { singleThread?: boolean }
    }
  }
}

/**
 * The shape Vite needs from a plugin. Declared structurally so this package
 * does not depend on `vite`'s types; `vitest` is an optional peer dependency
 * and consumers without it never load this file.
 */
export interface DbtxPlugin {
  name: string
  config(userConfig?: UserConfigLike): {
    test: {
      globalSetup: string[]
      setupFiles: string[]
      provide: { 'dbtx:config': ResolvedConfig }
    }
  }
}

function here(file: string): string {
  return fileURLToPath(new URL(file, import.meta.url))
}

/**
 * The Vitest plugin. It injects `globalSetup` and `setupFiles` and passes the
 * configuration through `provide`, so the user writes no hooks of their own
 * (SPEC §4).
 *
 * ```ts
 * // vitest.config.ts
 * import { dbtx } from 'dbtx-isolation/vitest'
 *
 * export default defineConfig({
 *   plugins: [dbtx({ url: process.env.DATABASE_URL! })],
 * })
 * ```
 *
 * Vite concatenates arrays when it merges this with the user's config, so any
 * `globalSetup` or `setupFiles` they already have are kept.
 */
export function dbtx(config: DbtxConfig): DbtxPlugin {
  // Validated here, in the config file, where the stack trace still points at
  // the mistake — not later inside a worker.
  const resolved = resolveConfig(config)

  return {
    name: 'dbtx',
    config(userConfig?: UserConfigLike) {
      assertSequenceResetIsPossible(resolved, userConfig)
      return {
        test: {
          globalSetup: [here('./vitest-global-setup.js')],
          setupFiles: [here('./vitest-setup.js')],
          provide: { 'dbtx:config': resolved },
        },
      }
    },
  }
}

/**
 * `resetSequences` cannot hold under `transaction` once more than one worker
 * runs, because every worker shares the one database that strategy uses and a
 * sequence is neither transactional nor per-session: one worker's reset lands
 * inside another worker's test.
 *
 * This reads the configuration rather than counting workers at runtime. A
 * project with a single test file starts a single worker whatever `maxWorkers`
 * says, so an observed count would pass today and break silently on the day a
 * second test file is added.
 */
function assertSequenceResetIsPossible(
  config: ResolvedConfig,
  userConfig: UserConfigLike | undefined,
): void {
  if (!config.resetSequences || config.strategy !== 'transaction') return

  const test = userConfig?.test
  // `vitest --no-file-parallelism` is applied after this hook runs, so the
  // flag has to be read from the command line or it looks like a parallel run.
  const serialOnCommandLine =
    process.argv.includes('--no-file-parallelism') ||
    process.argv.includes('--fileParallelism=false') ||
    process.argv.includes('--maxWorkers=1')

  const serial =
    serialOnCommandLine ||
    test?.fileParallelism === false ||
    test?.maxWorkers === 1 ||
    test?.poolOptions?.forks?.singleFork === true ||
    test?.poolOptions?.threads?.singleThread === true

  if (serial) return

  throw new Error(
    "dbtx: resetSequences cannot work with strategy: 'transaction' unless the run is " +
      'serial. Every worker shares your one database, and sequences are not transactional, ' +
      "so one worker's reset changes the ids another worker is about to get.\nEither give " +
      "each worker its own database with strategy: 'database', or run files one at a time " +
      '(`fileParallelism: false`, `maxWorkers: 1`, or a single fork/thread), or turn ' +
      'resetSequences off.',
  )
}

export default dbtx
