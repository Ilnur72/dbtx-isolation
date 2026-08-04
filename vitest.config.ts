import { defineConfig } from 'vitest/config'

// This is the config for dbtx's *own* test suite, so it deliberately does not
// use the dbtx plugin. Unit tests (test/rewrite.test.ts) must pass with no
// database available; integration tests skip themselves unless DATABASE_URL is
// set (SPEC §7).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
