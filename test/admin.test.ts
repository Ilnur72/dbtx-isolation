import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertSafeToDrop,
  computeFingerprint,
  databaseNameFromUrl,
  dropDatabase,
  expandGlobs,
  globToRegExp,
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
  const HASH = 'abc12345'

  it('are shaped for the template and for each worker', () => {
    expect(templateName('dbtx', HASH)).toBe('dbtx_tpl_abc12345')
    expect(workerDatabaseName('dbtx', HASH, 1)).toBe('dbtx_w1_abc12345')
    expect(workerDatabaseName('dbtx', HASH, 1)).not.toBe(workerDatabaseName('dbtx', HASH, 2))
  })

  it('stay inside the Postgres identifier limit at the longest prefix', () => {
    const prefix = 'a'.repeat(21)
    expect(Buffer.byteLength(workerDatabaseName(prefix, HASH, 9999))).toBeLessThanOrEqual(63)
  })

  it('reject a prefix that is not identifier-safe', () => {
    expect(() => templateName('My-App', HASH)).toThrow(/invalid prefix/)
  })
})

describe('computeFingerprint', () => {
  const base = { url: APP_URL, migrate: 'npx prisma migrate deploy' }

  it('is stable for the same configuration', async () => {
    expect(await computeFingerprint(base)).toBe(await computeFingerprint({ ...base }))
    expect(await computeFingerprint(base)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes with the target database, the commands, or the dbtx version', async () => {
    expect(await computeFingerprint(base)).not.toBe(
      await computeFingerprint({ ...base, migrate: 'other' }),
    )
    expect(await computeFingerprint(base)).not.toBe(
      await computeFingerprint({ ...base, seed: 'tsx test/seed.ts' }),
    )
    expect(await computeFingerprint(base)).not.toBe(
      await computeFingerprint({ ...base, url: 'postgres://user:pw@localhost:5432/otherapp' }),
    )
  })

  it('follows file contents when caching is on, which the command string cannot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dbtx-fp-'))
    await mkdir(join(root, 'migrations'), { recursive: true })
    await writeFile(join(root, 'migrations', '001_init.sql'), 'CREATE TABLE a (id int);')

    const cached = { ...base, cacheTemplate: { files: ['migrations/**/*.sql'] }, root }
    const before = await computeFingerprint(cached)

    // The command has not changed — only the migrations have. This is exactly
    // the case that makes a command-keyed cache serve a stale schema.
    await writeFile(join(root, 'migrations', '002_more.sql'), 'CREATE TABLE b (id int);')
    const after = await computeFingerprint(cached)

    expect(after).not.toBe(before)
    expect(await computeFingerprint(cached)).toBe(after)
  })

  it('refuses to cache against a pattern that matches nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dbtx-fp-'))
    await expect(
      computeFingerprint({ ...base, cacheTemplate: { files: ['migrations/**/*.sql'] }, root }),
    ).rejects.toThrow(/matched no files/)
  })
})

describe('globs', () => {
  it('translates the patterns people actually write', () => {
    expect(globToRegExp('migrations/**/*.sql').test('migrations/001.sql')).toBe(true)
    expect(globToRegExp('migrations/**/*.sql').test('migrations/a/b/001.sql')).toBe(true)
    expect(globToRegExp('migrations/**/*.sql').test('migrations/001.ts')).toBe(false)
    expect(globToRegExp('*.sql').test('a/b.sql')).toBe(false)
    expect(globToRegExp('prisma/schema.prisma').test('prisma/schema.prisma')).toBe(true)
    expect(globToRegExp('db/?.sql').test('db/1.sql')).toBe(true)
  })

  it('does not treat dots as wildcards', () => {
    expect(globToRegExp('a.sql').test('axsql')).toBe(false)
  })

  it('walks a directory tree, skipping node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dbtx-glob-'))
    await mkdir(join(root, 'migrations', 'nested'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(root, 'migrations', 'a.sql'), '')
    await writeFile(join(root, 'migrations', 'nested', 'b.sql'), '')
    await writeFile(join(root, 'migrations', 'c.txt'), '')
    await writeFile(join(root, 'node_modules', 'x', 'd.sql'), '')

    expect(await expandGlobs(['migrations/**/*.sql'], root)).toEqual([
      'migrations/a.sql',
      'migrations/nested/b.sql',
    ])
    expect(await expandGlobs(['**/*.sql'], root)).toEqual([
      'migrations/a.sql',
      'migrations/nested/b.sql',
    ])
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

describe('dropDatabase across server versions', () => {
  /** An AdminClient that records what it was asked and answers plausibly. */
  function fakeAdmin(version: string) {
    const sql: string[] = []
    const client = {
      async query(text: string): Promise<Array<Record<string, unknown>>> {
        sql.push(text.replace(/\s+/g, ' ').trim())
        if (text.includes('server_version_num')) return [{ v: version }]
        if (text.includes('FROM pg_database')) return [{ '?column?': 1 }]
        return []
      },
      async end(): Promise<void> {},
    }
    return { client, sql }
  }

  it('uses WITH (FORCE) from Postgres 13', async () => {
    const { client, sql } = fakeAdmin('130000')
    await dropDatabase(client, 'dbtx_w1_abc', { prefix: 'dbtx', applicationDatabase: 'myapp' })
    expect(sql).toContain('DROP DATABASE IF EXISTS "dbtx_w1_abc" WITH (FORCE)')
  })

  it('falls back to a plain DROP below 13, where FORCE does not exist', async () => {
    const { client, sql } = fakeAdmin('120018')
    await dropDatabase(client, 'dbtx_w1_abc', { prefix: 'dbtx', applicationDatabase: 'myapp' })
    expect(sql).toContain('DROP DATABASE IF EXISTS "dbtx_w1_abc"')
    expect(sql.some((s) => s.includes('WITH (FORCE)'))).toBe(false)
  })

  it('always clears the template flag and disconnects backends first', async () => {
    const { client, sql } = fakeAdmin('180000')
    await dropDatabase(client, 'dbtx_tpl_abc', { prefix: 'dbtx', applicationDatabase: 'myapp' })

    const alter = sql.findIndex((s) => s.includes('IS_TEMPLATE false'))
    const terminate = sql.findIndex((s) => s.includes('pg_terminate_backend'))
    const drop = sql.findIndex((s) => s.startsWith('DROP DATABASE'))
    expect(alter).toBeGreaterThanOrEqual(0)
    expect(terminate).toBeGreaterThan(alter)
    expect(drop).toBeGreaterThan(terminate)
  })

  it('refuses before it asks the server anything', async () => {
    const { client, sql } = fakeAdmin('180000')
    await expect(
      dropDatabase(client, 'myapp', { prefix: 'dbtx', applicationDatabase: 'myapp' }),
    ).rejects.toThrow(/DATABASE_URL points at/)
    expect(sql).toEqual([])
  })
})
