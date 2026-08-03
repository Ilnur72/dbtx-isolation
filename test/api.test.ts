import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newCtx, setAmbient } from '../src/core/context.js'
import {
  assertDriverIdentity,
  clearDriver,
  useDriver,
  verifyDriverIdentity,
} from '../src/drivers/index.js'
import { dbtx } from '../src/index.js'
import { dbtx as plugin } from '../src/runners/vitest.js'

// The public API (SPEC §4) and the driver-identity check the runner depends
// on. No database.

afterEach(() => {
  setAmbient(undefined)
  clearDriver()
  vi.restoreAllMocks()
})

describe('the dbtx object', () => {
  it('reports no isolation when no test is active', () => {
    expect(dbtx.isolated).toBe(false)
    expect(dbtx.depth).toBe(0)
  })

  it('reports isolation and depth from the active context', () => {
    const ctx = newCtx('t1')
    setAmbient(ctx)
    expect(dbtx.isolated).toBe(true)

    ctx.depth = 2
    expect(dbtx.depth).toBe(2)

    ctx.active = false
    expect(dbtx.isolated).toBe(false)
  })

  it('is not isolated while uncommitted() is running', async () => {
    setAmbient(newCtx('t1'))
    await dbtx.uncommitted(() => {
      expect(dbtx.isolated).toBe(false)
    })
    expect(dbtx.isolated).toBe(true)
  })

  it('returns what uncommitted() returned, and restores on throw', async () => {
    const ctx = newCtx('t1')
    setAmbient(ctx)

    await expect(dbtx.uncommitted(async () => 'value')).resolves.toBe('value')
    expect(ctx.bypass).toBe(false)

    await expect(dbtx.uncommitted(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(ctx.bypass).toBe(false)
  })
})

describe('driver injection', () => {
  it('accepts the pg module, and the namespace object around it', async () => {
    const pg = await import('pg')
    expect(() => useDriver(pg)).not.toThrow()
    expect(verifyDriverIdentity().status).toBe('injected')

    clearDriver()
    const inner = (pg as unknown as { default?: unknown }).default
    expect(() => useDriver(inner)).not.toThrow()
  })

  it('refuses anything that is not pg, instead of patching nothing', () => {
    for (const value of [undefined, null, {}, 'pg', { Client: 1 }]) {
      expect(() => useDriver(value)).toThrow(/not the `pg` module/)
    }
  })
})

describe('driver identity', () => {
  it('matches when dbtx and the project resolve the same pg', () => {
    const identity = verifyDriverIdentity(process.cwd())
    expect(identity.status).toBe('match')
  })

  it('says so when the project has no pg at all', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dbtx-noprj-'))
    const identity = verifyDriverIdentity(empty)
    expect(identity.status).toBe('unknown')
  })

  it('warns about an unverifiable setup, and fails under strict', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dbtx-noprj-'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(assertDriverIdentity({ strict: false, cwd: empty }).status).toBe('unknown')
    expect(String(spy.mock.calls[0])).toMatch(/could not confirm/)

    expect(() => assertDriverIdentity({ strict: true, cwd: empty })).toThrow(/could not confirm/)
  })

  it('never asks the question once the driver was injected', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dbtx-noprj-'))
    useDriver(await import('pg'))
    // Explicit injection is the whole point: there is nothing left to resolve.
    expect(assertDriverIdentity({ strict: true, cwd: empty }).status).toBe('injected')
  })
})

describe('the vitest plugin', () => {
  it('injects globalSetup and setupFiles, and provides the resolved config', () => {
    const result = plugin({ url: 'postgres://user:pw@localhost:5432/myapp' }).config()

    expect(result.test.globalSetup[0]).toMatch(/vitest-global-setup\.(js|ts)$/)
    expect(result.test.setupFiles[0]).toMatch(/vitest-setup\.(js|ts)$/)
    expect(result.test.provide['dbtx:config']).toMatchObject({
      url: 'postgres://user:pw@localhost:5432/myapp',
      strategy: 'transaction',
      prefix: 'dbtx',
      resetSequences: false,
      strict: false,
    })
  })

  it('validates the config in the config file, where the mistake is', () => {
    expect(() => plugin({ url: 'postgres://x/y', prefix: 'Not Valid' })).toThrow(/invalid prefix/)
  })

  describe('resetSequences under a parallel run', () => {
    const withReset = { url: 'postgres://x/y', resetSequences: true } as const

    it('is refused, from the config rather than from a worker count', () => {
      // Deliberately not "how many workers do I see": one test file starts one
      // worker whatever maxWorkers says, so an observed count would pass today
      // and break silently when a second file is added.
      expect(() => plugin(withReset).config({})).toThrow(/unless the run is serial/)
      expect(() => plugin(withReset).config()).toThrow(/unless the run is serial/)
      expect(() => plugin(withReset).config({ test: { maxWorkers: 4 } })).toThrow(
        /unless the run is serial/,
      )
    })

    it('is allowed when the config says the run is serial', () => {
      for (const test of [
        { fileParallelism: false },
        { maxWorkers: 1 },
        { poolOptions: { forks: { singleFork: true } } },
        { poolOptions: { threads: { singleThread: true } } },
      ]) {
        expect(() => plugin(withReset).config({ test }), JSON.stringify(test)).not.toThrow()
      }
    })

    it('does not apply to the database strategy, where each worker has its own', () => {
      expect(() => plugin({ ...withReset, strategy: 'database' }).config({})).not.toThrow()
    })
  })
})
