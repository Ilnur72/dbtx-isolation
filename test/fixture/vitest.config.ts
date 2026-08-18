import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { dbtx } from 'dbtx-isolation/vitest'

// A user's config, exactly as the README shows it: dbtx-isolation is imported
// by package name, so this resolves through package.json `exports` into dist/ —
// which means the fixture tests what users actually install, and a broken
// exports map or a missing build fails here.
export default defineConfig({
  plugins: [
    dbtx({
      url: process.env['DATABASE_URL']!,
      strategy: (process.env['DBTX_FIXTURE_STRATEGY'] as 'transaction' | 'database') ?? 'transaction',
      // Absolute: dbtx runs migrate from the process cwd, which is not
      // necessarily the directory this config lives in.
      // Quoted: `migrate` is a shell command, so a path with spaces in it is
      // the caller's to quote.
      migrate: `node "${fileURLToPath(new URL('../apply-schema.mjs', import.meta.url))}"`,
      seed: `node "${fileURLToPath(new URL('../apply-seed.mjs', import.meta.url))}"`,
      resetSequences: true,
      prefix: 'dbtxfx',
    }),
  ],
  test: {
    include: ['**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // resetSequences under `transaction` needs a serial run: every worker
    // shares the one database, and sequences are not transactional.
    fileParallelism: process.env['DBTX_FIXTURE_STRATEGY'] === 'database',
  },
})
