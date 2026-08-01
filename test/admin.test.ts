import { describe, expect, it } from 'vitest'
import {
  assertSafeToDrop,
  databaseNameFromUrl,
  likePatternFor,
  quoteIdent,
  templateName,
  urlForDatabase,
  workerDatabaseName,
} from '../src/admin.js'

// The pure half of admin.ts: name building and the guards that decide what may
// be dropped. No database involved — and these are exactly the places where a
// mistake destroys someone's data, so they are tested hardest.

const APP_URL = 'postgres://user:pw@localhost:5432/myapp'

describe('quoteIdent', () => {
  it('quotes and escapes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('Mixed Case')).toBe('"Mixed Case"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
    expect(quoteIdent('a"; DROP DATABASE x; --')).toBe('"a""; DROP DATABASE x; --"')
  })

  it('refuses names it cannot quote safely', () => {
    expect(() => quoteIdent('')).toThrow(/unusable identifier/)
    expect(() => quoteIdent('a\0b')).toThrow(/unusable identifier/)
  })
})

describe('connection strings', () => {
  it('reads the database name', () => {
    expect(databaseNameFromUrl(APP_URL)).toBe('myapp')
    expect(databaseNameFromUrl('postgres://localhost/with%20space')).toBe('with space')
  })

  it('repoints at another database, keeping credentials and options', () => {
    const admin = urlForDatabase(APP_URL, 'postgres')
    expect(databaseNameFromUrl(admin)).toBe('postgres')
    expect(admin).toContain('user:pw@localhost:5432')

    const withParams = urlForDatabase(`${APP_URL}?sslmode=require`, 'postgres')
    expect(withParams).toContain('sslmode=require')
  })
})

describe('generated names', () => {
  const base = { url: APP_URL, prefix: 'dbtx', migrate: 'npx prisma migrate deploy' }

  it('are stable for the same configuration', () => {
    expect(templateName(base)).toBe(templateName({ ...base }))
    expect(templateName(base)).toMatch(/^dbtx_tpl_[0-9a-f]{8}$/)
  })

  it('change when the migrations or the target database change', () => {
    expect(templateName(base)).not.toBe(templateName({ ...base, migrate: 'other' }))
    expect(templateName(base)).not.toBe(
      templateName({ ...base, url: 'postgres://user:pw@localhost:5432/otherapp' }),
    )
  })

  it('give each worker its own database', () => {
    const one = workerDatabaseName({ ...base, poolId: 1 })
    const two = workerDatabaseName({ ...base, poolId: 2 })
    expect(one).toMatch(/^dbtx_w1_[0-9a-f]{8}$/)
    expect(one).not.toBe(two)
  })

  it('stay inside the Postgres identifier limit even at the longest prefix', () => {
    const prefix = 'a'.repeat(21)
    expect(Buffer.byteLength(workerDatabaseName({ ...base, prefix, poolId: 9999 }))).toBeLessThanOrEqual(63)
  })

  it('reject a prefix that is not identifier-safe', () => {
    expect(() => templateName({ ...base, prefix: 'My-App' })).toThrow(/invalid prefix/)
  })
})

describe('assertSafeToDrop', () => {
  it('allows our own databases', () => {
    expect(() => assertSafeToDrop('dbtx_w1_abc12345', 'dbtx', 'myapp')).not.toThrow()
    expect(() => assertSafeToDrop('dbtx_tpl_abc12345', 'dbtx', 'myapp')).not.toThrow()
  })

  it('never drops the application database', () => {
    expect(() => assertSafeToDrop('myapp', 'dbtx', 'myapp')).toThrow(/DATABASE_URL points at/)
  })

  it('never drops a system database', () => {
    for (const name of ['postgres', 'template0', 'template1']) {
      expect(() => assertSafeToDrop(name, 'dbtx', 'myapp'), name).toThrow(/system database/)
    }
  })

  it('never drops a database that is not prefixed as ours', () => {
    for (const name of ['production', 'dbtx', 'dbtxfoo', 'xdbtx_1', 'other_w1_abc']) {
      expect(() => assertSafeToDrop(name, 'dbtx', 'myapp'), name).toThrow(/did not create it/)
    }
  })

  it('refuses to work with an unusable prefix at all', () => {
    expect(() => assertSafeToDrop('anything', '', 'myapp')).toThrow(/invalid prefix/)
    expect(() => assertSafeToDrop('%_x', '%', 'myapp')).toThrow(/invalid prefix/)
  })
})

describe('likePatternFor', () => {
  it('escapes the separator so the wildcard cannot widen the match', () => {
    expect(likePatternFor('dbtx')).toBe('dbtx\\_%')
  })

  it('escapes wildcards inside the prefix itself', () => {
    expect(likePatternFor('my_app')).toBe('my\\_app\\_%')
  })

  it('matches what we create and nothing else', () => {
    // Mirror of Postgres LIKE with ESCAPE '\': \x is a literal x, _ is any one
    // character, % is any run.
    const like = (pattern: string, value: string): boolean => {
      let regex = ''
      for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i] ?? ''
        if (ch === '\\') {
          i += 1
          regex += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        } else if (ch === '%') regex += '.*'
        else if (ch === '_') regex += '.'
        else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      return new RegExp(`^${regex}$`).test(value)
    }

    const pattern = likePatternFor('dbtx')
    expect(like(pattern, 'dbtx_w1_abc12345')).toBe(true)
    expect(like(pattern, 'dbtx_tpl_abc12345')).toBe(true)
    // The bug an unescaped pattern would hide: `_` matching any character.
    expect(like(pattern, 'dbtxXw1_abc')).toBe(false)
    expect(like(pattern, 'dbtx')).toBe(false)
    expect(like(pattern, 'mydbtx_w1')).toBe(false)
  })
})
