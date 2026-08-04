import { log } from '../core/log.js'
import { makeStrategy } from '../strategies/index.js'
import type { GlobalData, ResolvedConfig } from '../types.js'
import './vitest.js' // brings the ProvidedContext declarations with it

/** The part of Vitest's `TestProject` this file uses. */
interface ProjectLike {
  provide: (key: 'dbtx:global', value: GlobalData) => void
  getProvidedContext: () => { 'dbtx:config'?: ResolvedConfig }
}

/**
 * Runs once for the whole run, in the main process, before any worker exists —
 * which is exactly what building a template database requires (SPEC §3.6).
 *
 * The `transaction` strategy has no work here at all; it never commits
 * anything, so there is nothing to prepare or clean up.
 */
export default async function setup(project: ProjectLike): Promise<() => Promise<void>> {
  const config = project.getProvidedContext()['dbtx:config']
  if (config === undefined) {
    throw new Error(
      'dbtx: the configuration never reached globalSetup. Add the plugin to your vitest ' +
        "config: `import { dbtx } from 'dbtx-isolation/vitest'` and `plugins: [dbtx({ ... })]`.",
    )
  }

  const strategy = makeStrategy(config.strategy, config)
  const data = (await strategy.globalSetup?.()) ?? { url: config.url }
  project.provide('dbtx:global', data)
  log(`global setup done for the ${strategy.name} strategy`)

  return async () => {
    await strategy.globalTeardown?.(data)
    log('global teardown done')
  }
}
