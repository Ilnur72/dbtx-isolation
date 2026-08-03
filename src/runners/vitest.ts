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

/**
 * The shape Vite needs from a plugin. Declared structurally so this package
 * does not depend on `vite`'s types; `vitest` is an optional peer dependency
 * and consumers without it never load this file.
 */
export interface DbtxPlugin {
  name: string
  config(): {
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
 * import { dbtx } from 'dbtx/vitest'
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
    config() {
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

export default dbtx
