import { defineConfig } from 'vitest/config'
import { dbtx } from '../../src/runners/vitest.js'

// A user's config, as the README will show it. The only difference is that it
// points at the source rather than the published package.
export default defineConfig({
  plugins: [
    dbtx({
      url: process.env['DATABASE_URL']!,
      strategy: (process.env['DBTX_FIXTURE_STRATEGY'] as 'transaction' | 'database') ?? 'transaction',
      migrate: 'node ../apply-schema.mjs',
      resetSequences: true,
      prefix: 'dbtxfx',
    }),
  ],
  test: { include: ['**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
})
