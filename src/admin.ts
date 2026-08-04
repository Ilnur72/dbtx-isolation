import { exec } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { promisify } from 'node:util'
import { assertIdentifierFits, assertValidPrefix, TEMPLATE_EPOCH } from './core/config.js'
import { log, warn } from './core/log.js'
import { exempt, loadPgOrThrow } from './drivers/index.js'

const run = promisify(exec)

/** Databases that must never be dropped, whatever the prefix says. */
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1'])

/** Never walked when expanding globs for the template fingerprint. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage'])

/** `DROP DATABASE ... WITH (FORCE)` exists from Postgres 13. */
const FORCE_DROP_MIN_VERSION = 130000

type Row = Record<string, unknown>

/** A maintenance connection: never patched, never inside a transaction. */
export interface AdminClient {
  query(sql: string, values?: unknown[]): Promise<Row[]>
  end(): Promise<void>
}

/**
 * Quote an identifier for a statement that cannot take parameters. All DDL
 * here is in that position — `CREATE DATABASE $1` is not a thing — so names
 * go through this and never through string concatenation.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes('\0')) {
    throw new Error(`dbtx: refusing to quote the unusable identifier ${JSON.stringify(name)}`)
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a string literal, for the same statements that cannot take parameters. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The database a connection string points at. */
export function databaseNameFromUrl(url: string): string {
  const parsed = new URL(url)
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''))
}

/** The same connection string, pointed at a different database. */
export function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${encodeURIComponent(database)}`
  return parsed.toString()
}

/** Turn one glob into an anchored regular expression over posix paths. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? ''
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?' // `**/` also matches zero directories
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * The leading part of a glob with no wildcard in it, so the walk can start
 * there rather than at the project root.
 */
function staticPrefix(pattern: string): string {
  const fixed: string[] = []
  for (const segment of pattern.split('/').slice(0, -1)) {
    if (/[*?]/.test(segment)) break
    fixed.push(segment)
  }
  return fixed.join('/')
}

async function walk(root: string, relative: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true })
  } catch {
    return // a pattern may point at a directory that does not exist
  }
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      await walk(root, child, out)
    } else if (entry.isFile()) {
      out.push(child)
    }
  }
}

/** Files matching any of `patterns`, relative to `root`, sorted. */
export async function expandGlobs(patterns: string[], root: string): Promise<string[]> {
  const matched = new Set<string>()
  for (const pattern of patterns) {
    const normalized = pattern.split(sep).join(posix.sep)
    const regex = globToRegExp(normalized)
    const found: string[] = []
    await walk(root, staticPrefix(normalized), found)
    for (const file of found) {
      if (regex.test(file)) matched.add(file)
    }
  }
  return [...matched].sort()
}

export interface FingerprintOptions {
  /** The application's own connection string. */
  url: string
  migrate?: string
  seed?: string
  cacheTemplate?: { files: string[] }
  /** Project root the cache globs are relative to. Defaults to `process.cwd()`. */
  root?: string
}

/**
 * A short, stable fingerprint of everything that decides what ends up inside
 * the template, so two projects on one server never share a name.
 *
 * When template caching is on, the file *contents* are what the name is keyed
 * on. Hashing the `migrate` command string would be worse than useless:
 * `npm run migrate` does not change when a migration is added, so a cached
 * template would be reused against a schema that has moved on and the tests
 * would quietly run against yesterday's database.
 */
export async function computeFingerprint(options: FingerprintOptions): Promise<string> {
  const hash = createHash('sha256')
  hash.update(TEMPLATE_EPOCH)
  hash.update('\0')
  hash.update(databaseNameFromUrl(options.url))
  hash.update('\0')
  hash.update(options.migrate ?? '')
  hash.update('\0')
  hash.update(options.seed ?? '')

  if (options.cacheTemplate !== undefined) {
    const root = options.root ?? process.cwd()
    const files = await expandGlobs(options.cacheTemplate.files, root)
    if (files.length === 0) {
      throw new Error(
        `dbtx: cacheTemplate.files matched no files under ${JSON.stringify(root)} ` +
          `(${options.cacheTemplate.files.join(', ')}). A fingerprint over nothing would ` +
          'never change, so a stale template could never be detected.',
      )
    }
    for (const file of files) {
      hash.update('\0')
      hash.update(file)
      hash.update('\0')
      hash.update(await readFile(join(root, file)))
    }
    log(`template fingerprint covers ${files.length} file(s)`)
  }

  return hash.digest('hex').slice(0, 8)
}

/** Name of the template database for a fingerprint. */
export function templateName(prefix: string, fingerprint: string): string {
  assertValidPrefix(prefix)
  return assertIdentifierFits(`${prefix}_tpl_${fingerprint}`)
}

/** Name of one worker's database (SPEC §3.5 — `VITEST_POOL_ID`). */
export function workerDatabaseName(prefix: string, fingerprint: string, poolId: number): string {
  assertValidPrefix(prefix)
  return assertIdentifierFits(`${prefix}_w${poolId}_${fingerprint}`)
}

/**
 * Refuse to touch anything that is not ours.
 *
 * One mistake here drops databases that belong to somebody else, so the checks
 * are deliberately paranoid: a non-empty validated prefix, an exact
 * `<prefix>_` match, never a system database, and never the application's own
 * database — dbtx must not drop the developer's dev database, ever.
 */
export function assertSafeToDrop(name: string, prefix: string, applicationDatabase: string): void {
  assertValidPrefix(prefix)
  if (SYSTEM_DATABASES.has(name)) {
    throw new Error(`dbtx: refusing to drop the system database ${JSON.stringify(name)}`)
  }
  if (name === applicationDatabase) {
    throw new Error(
      `dbtx: refusing to drop ${JSON.stringify(name)} — it is the database your ` +
        'DATABASE_URL points at. dbtx only ever drops the databases it created itself.',
    )
  }
  if (!name.startsWith(`${prefix}_`)) {
    throw new Error(
      `dbtx: refusing to drop ${JSON.stringify(name)} — it does not start with ` +
        `${JSON.stringify(`${prefix}_`)}, so dbtx did not create it.`,
    )
  }
}

/**
 * `LIKE` pattern matching exactly our databases. `_` and `%` are wildcards, so
 * an unescaped `dbtx_%` would also match `dbtxXfoo` — the difference between
 * dropping our databases and dropping somebody else's.
 */
export function likePatternFor(prefix: string): string {
  assertValidPrefix(prefix)
  return `${prefix.replace(/[\\%_]/g, '\\$&')}\\_%`
}

async function open(url: string): Promise<AdminClient> {
  const pg = await loadPgOrThrow()
  const client = new pg.Client({ connectionString: url })
  // CREATE DATABASE and DROP DATABASE cannot run inside a transaction block,
  // so a lazy BEGIN on this connection would break dbtx's own DDL. Marked
  // exempt before connecting, not left to luck (SPEC §3.7).
  exempt(client)
  await client.connect()
  return {
    async query(sql: string, values?: unknown[]): Promise<Row[]> {
      const result = (await client.query(sql, values)) as { rows: Row[] }
      return result.rows
    },
    async end(): Promise<void> {
      await client.end()
    },
  }
}

export interface AdminOptions {
  /** The application's own connection string; only the server part is used. */
  url: string
  /**
   * Database to run administrative statements on. Never the target: you cannot
   * drop a database you are connected to. Defaults to the order below.
   */
  maintenanceDatabase?: string
}

/**
 * Where to run administrative statements, in order of preference.
 *
 * The application's own database comes before `template1` on purpose: holding
 * a connection to `template1` blocks everyone else's plain `CREATE DATABASE`,
 * which clones from it by default. Connecting to the application's database is
 * harmless, since dbtx never drops it.
 */
function maintenanceCandidates(options: AdminOptions): string[] {
  if (options.maintenanceDatabase !== undefined) return [options.maintenanceDatabase]
  const application = databaseNameFromUrl(options.url)
  return [...new Set(['postgres', application, 'template1'])].filter((name) => name !== '')
}

/**
 * Run `fn` against a maintenance database, closing the connection afterwards
 * whatever happens.
 */
export async function withAdmin<T>(
  options: AdminOptions,
  fn: (client: AdminClient) => Promise<T>,
): Promise<T> {
  const candidates = maintenanceCandidates(options)

  let lastError: unknown
  for (const database of candidates) {
    let client: AdminClient
    try {
      client = await open(urlForDatabase(options.url, database))
    } catch (err) {
      log(`admin connection to ${database} failed:`, err)
      lastError = err
      continue
    }
    try {
      return await fn(client)
    } finally {
      await client.end().catch((err: unknown) => {
        log('closing the admin connection failed:', err)
      })
    }
  }

  throw new Error(
    `dbtx: could not open an admin connection to any of ${candidates.join(', ')}. ` +
      'Set `maintenanceDatabase` to a database your user can connect to.',
    { cause: lastError },
  )
}

/**
 * Open a long-lived exempt connection to one database. The strategies hold one
 * of these per worker for sequence resets and truncation, rather than
 * reconnecting for every test.
 */
export async function openMaintenance(url: string, database?: string): Promise<AdminClient> {
  return open(database === undefined ? url : urlForDatabase(url, database))
}

/**
 * Run `fn` against one specific database, on an exempt connection, closing it
 * afterwards. This is how sequence resets and truncation reach a worker's
 * database without being rewritten or wrapped (SPEC §3.7).
 */
export async function withDb<T>(
  url: string,
  database: string,
  fn: (client: AdminClient) => Promise<T>,
): Promise<T> {
  const client = await open(urlForDatabase(url, database))
  try {
    return await fn(client)
  } finally {
    await client.end().catch((err: unknown) => {
      log(`closing the connection to ${database} failed:`, err)
    })
  }
}

async function serverVersion(admin: AdminClient): Promise<number> {
  const rows = await admin.query("SELECT current_setting('server_version_num') AS v")
  const raw = rows[0]?.['v']
  const value = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(value) ? value : 0
}

/** Disconnect everyone else from a database so it can be dropped. */
async function terminateBackends(admin: AdminClient, database: string): Promise<void> {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  )
}

/**
 * Drop one of our databases.
 *
 * A database left marked as a template by a crashed run cannot be dropped at
 * all, so that flag is cleared first. Connections are then terminated, because
 * `WITH (FORCE)` only exists from Postgres 13 and even there it still fails if
 * the database holds a prepared transaction or a logical replication slot.
 */
export async function dropDatabase(
  admin: AdminClient,
  name: string,
  options: { prefix: string; applicationDatabase: string },
): Promise<boolean> {
  assertSafeToDrop(name, options.prefix, options.applicationDatabase)

  const exists = await databaseExists(admin, name)
  if (!exists) return false

  // `DROP DATABASE` refuses a template, and a crashed run may have left this
  // one marked as one.
  try {
    await admin.query(
      `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`,
    )
  } catch (err) {
    log(`could not clear the template flag on ${name}:`, err)
  }

  await terminateBackends(admin, name)

  const force = (await serverVersion(admin)) >= FORCE_DROP_MIN_VERSION
  const sql = `DROP DATABASE IF EXISTS ${quoteIdent(name)}${force ? ' WITH (FORCE)' : ''}`
  try {
    await admin.query(sql)
  } catch (err) {
    throw new Error(
      `dbtx: could not drop the database ${JSON.stringify(name)}. A prepared transaction or ` +
        'a logical replication slot on it will block the drop even with WITH (FORCE); ' +
        'clear those and try again.',
      { cause: err },
    )
  }
  log('dropped database', name)
  return true
}

async function databaseExists(admin: AdminClient, name: string): Promise<boolean> {
  const rows = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  return rows.length > 0
}

/** Advisory lock key derived from a name, so it is stable across processes. */
function lockKey(name: string): string {
  const digest = createHash('sha256').update(name).digest()
  // 31 bits: comfortably inside bigint, and inside a JS safe integer.
  return String(digest.readUInt32BE(0) & 0x7fffffff)
}

async function withAdvisoryLock<T>(
  admin: AdminClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(name)
  await admin.query('SELECT pg_advisory_lock($1::bigint)', [key])
  try {
    return await fn()
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch((err: unknown) => {
      log('releasing the advisory lock failed:', err)
    })
  }
}

async function runCommand(command: string, databaseUrl: string): Promise<void> {
  log('running', command)
  try {
    const { stdout, stderr } = await run(command, {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 32 * 1024 * 1024,
    })
    if (stdout.trim() !== '') log(stdout.trim())
    if (stderr.trim() !== '') log(stderr.trim())
  } catch (err) {
    const detail = err as { stdout?: string; stderr?: string }
    throw new Error(
      `dbtx: the command ${JSON.stringify(command)} failed while preparing the template ` +
        `database.\n${detail.stdout ?? ''}${detail.stderr ?? ''}`.trimEnd(),
      { cause: err },
    )
  }
}

export interface TemplateOptions extends AdminOptions {
  prefix: string
  /** From {@link computeFingerprint}. */
  fingerprint: string
  migrate?: string
  seed?: string
  /** Reuse a finished template instead of rebuilding it. Off by default. */
  cache?: boolean
}

export interface TemplateResult {
  name: string
  /** True when an existing, finished template was reused. */
  reused: boolean
}

/** How a database was created: everything that changes what the data means. */
interface DatabaseLocale {
  encoding: string
  collate: string
  ctype: string
  /** `c` libc, `i` ICU, `b` builtin. Absent before Postgres 15. */
  provider?: string
  /** ICU or builtin locale name, where the server has one. */
  locale?: string
}

/**
 * Read the application database's encoding and locale.
 *
 * The catalogue changed across the versions we support: `datlocprovider` and
 * `daticulocale` arrived in 15, and 17 renamed the latter to `datlocale`. So
 * the columns are discovered rather than assumed.
 */
async function readLocale(admin: AdminClient, database: string): Promise<DatabaseLocale | undefined> {
  const columns = new Set(
    (
      await admin.query(
        `SELECT attname FROM pg_attribute
          WHERE attrelid = 'pg_database'::regclass
            AND NOT attisdropped
            AND attname IN ('datlocprovider', 'daticulocale', 'datlocale')`,
      )
    ).map((row) => String(row['attname'])),
  )

  const localeColumn = columns.has('datlocale')
    ? 'datlocale'
    : columns.has('daticulocale')
      ? 'daticulocale'
      : undefined

  const selected = [
    'pg_encoding_to_char(encoding) AS encoding',
    'datcollate',
    'datctype',
    columns.has('datlocprovider') ? 'datlocprovider' : 'NULL AS datlocprovider',
    localeColumn === undefined ? 'NULL AS loc' : `${localeColumn} AS loc`,
  ].join(', ')

  const rows = await admin.query(
    `SELECT ${selected} FROM pg_database WHERE datname = $1`,
    [database],
  )
  const row = rows[0]
  if (row === undefined) return undefined

  const provider = row['datlocprovider']
  const locale = row['loc']
  return {
    encoding: String(row['encoding']),
    collate: String(row['datcollate']),
    ctype: String(row['datctype']),
    ...(typeof provider === 'string' && provider !== '' ? { provider } : {}),
    ...(typeof locale === 'string' && locale !== '' ? { locale } : {}),
    }
}

/**
 * The `CREATE DATABASE` options that reproduce a database's locale.
 *
 * Without these the template inherits the *server's* defaults from
 * `template0`, not the application's. When they differ, text sorts differently
 * in tests than in production — `ORDER BY` on `a, B, c` gives `a, B, c` under
 * en_US and `B, a, c` under C — and nothing announces it. Only `template0`
 * accepts these options, which is the template dbtx clones from anyway.
 */
function localeOptions(locale: DatabaseLocale, useLocaleKeyword: boolean): string {
  const parts = [
    `ENCODING ${quoteLiteral(locale.encoding)}`,
    `LC_COLLATE ${quoteLiteral(locale.collate)}`,
    `LC_CTYPE ${quoteLiteral(locale.ctype)}`,
  ]

  if (locale.provider === 'i') {
    parts.push("LOCALE_PROVIDER 'icu'")
    if (locale.locale !== undefined) {
      // Postgres 17 renamed ICU_LOCALE to LOCALE.
      parts.push(`${useLocaleKeyword ? 'LOCALE' : 'ICU_LOCALE'} ${quoteLiteral(locale.locale)}`)
    }
  } else if (locale.provider === 'b') {
    parts.push("LOCALE_PROVIDER 'builtin'")
    if (locale.locale !== undefined) {
      parts.push(`BUILTIN_LOCALE ${quoteLiteral(locale.locale)}`)
    }
  }

  return parts.join(' ')
}

/**
 * Whether a template database exists and, if it does, whether it was ever
 * finished.
 *
 * `datistemplate` is the completion flag. Setting it is the very last step of
 * building a template, so a database that exists without it is the wreckage of
 * a run that died midway — half-migrated, and the most dangerous thing we
 * could hand to a test suite. Callers must hold the advisory lock before
 * asking, because the drop path clears the flag before dropping and would
 * otherwise look exactly like a half-built template to somebody else.
 */
async function templateState(
  admin: AdminClient,
  name: string,
): Promise<'missing' | 'incomplete' | 'ready'> {
  const rows = await admin.query('SELECT datistemplate FROM pg_database WHERE datname = $1', [name])
  const row = rows[0]
  if (row === undefined) return 'missing'
  return row['datistemplate'] === true ? 'ready' : 'incomplete'
}

/**
 * Create the template from `template0`, carrying over the application
 * database's encoding and locale so text behaves in tests the way it behaves
 * in production.
 *
 * If the server will not accept those options — an ICU locale the build does
 * not have, say — the template is still created, but loudly, because sorting
 * that silently disagrees with production is the failure we are avoiding.
 */
async function createFromTemplate0(
  admin: AdminClient,
  name: string,
  applicationDatabase: string,
): Promise<void> {
  const locale = await readLocale(admin, applicationDatabase)
  if (locale === undefined) {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`)
    return
  }

  const useLocaleKeyword = (await serverVersion(admin)) >= 170000
  const options = localeOptions(locale, useLocaleKeyword)
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0 ${options}`)
    log('template locale:', options)
  } catch (err) {
    warn(
      `dbtx: could not give the template database the same locale as ${applicationDatabase} ` +
        `(${options}). Falling back to the server defaults — text may sort differently in ` +
        'tests than in production.',
      err,
    )
    await admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`)
  }
}

/**
 * Build the template database once per run, in `globalSetup`, before any
 * worker exists (SPEC §3.6).
 *
 * The final step is what makes parallel cloning safe: once the template is
 * marked `IS_TEMPLATE true ALLOW_CONNECTIONS false` nothing can connect to it,
 * which is exactly the condition `CREATE DATABASE ... TEMPLATE` requires — so
 * the race where one worker clones while another still holds a connection
 * cannot happen. `template0` works the same way. It doubles as the "this
 * template is finished" flag; see {@link templateState}.
 *
 * Creation is serialised with an advisory lock, since every worker would
 * otherwise try to build it at once.
 */
export async function createTemplate(options: TemplateOptions): Promise<TemplateResult> {
  const name = templateName(options.prefix, options.fingerprint)
  const applicationDatabase = databaseNameFromUrl(options.url)

  return withAdmin(options, async (admin) =>
    withAdvisoryLock(admin, name, async () => {
      const state = await templateState(admin, name)

      if (state === 'ready' && options.cache === true) {
        log('reusing the cached template', name)
        return { name, reused: true }
      }
      if (state === 'incomplete') {
        warn(
          `dbtx: the template database ${name} was left half-built by an earlier run and is ` +
            'being rebuilt.',
        )
      }
      if (state !== 'missing') {
        await dropDatabase(admin, name, { prefix: options.prefix, applicationDatabase })
      }

      log('creating template', name)
      await createFromTemplate0(admin, name, applicationDatabase)

      const templateUrl = urlForDatabase(options.url, name)
      if (options.migrate !== undefined) await runCommand(options.migrate, templateUrl)
      if (options.seed !== undefined) await runCommand(options.seed, templateUrl)

      // Sealed only once migrate and seed have had their connections, so the
      // flag can never be set on an unfinished database.
      await admin.query(
        `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      )
      log('template ready and sealed:', name)
      return { name, reused: false }
    }),
  )
}

/**
 * Drop the template built by {@link createTemplate}, under the same advisory
 * lock, so a concurrent run never observes the half-dropped state.
 */
export async function dropTemplate(options: TemplateOptions): Promise<boolean> {
  const name = templateName(options.prefix, options.fingerprint)
  const applicationDatabase = databaseNameFromUrl(options.url)
  return withAdmin(options, (admin) =>
    withAdvisoryLock(admin, name, () =>
      dropDatabase(admin, name, { prefix: options.prefix, applicationDatabase }),
    ),
  )
}

export interface CloneOptions extends AdminOptions {
  prefix: string
  /** Source database, normally the sealed template. */
  template: string
  /** Database to create. Must be one of ours. */
  database: string
}

/**
 * Clone the template into a worker's own database. In Postgres this is a
 * file-level copy, far cheaper than re-running migrations (SPEC §3.6).
 */
export async function cloneDatabase(options: CloneOptions): Promise<string> {
  const applicationDatabase = databaseNameFromUrl(options.url)
  assertSafeToDrop(options.database, options.prefix, applicationDatabase)

  await withAdmin(options, async (admin) => {
    await dropDatabase(admin, options.database, {
      prefix: options.prefix,
      applicationDatabase,
    })
    const sql = `CREATE DATABASE ${quoteIdent(options.database)} TEMPLATE ${quoteIdent(options.template)}`
    try {
      await admin.query(sql)
    } catch (err) {
      // Two workers cloning the same template at the same moment can collide
      // on the source lock; one short retry settles it.
      log('clone failed, retrying once:', err)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await admin.query(sql)
    }
    log('cloned', options.template, '->', options.database)
  })

  return options.database
}

export interface PruneOptions extends AdminOptions {
  prefix: string
  /** Also drop databases that currently have connections. Off by default. */
  includeActive?: boolean
  /** Databases to leave alone even though they match the prefix. */
  keep?: string[]
}

/**
 * Drop `<prefix>_*` databases left behind by crashed runs, called at the start
 * of `globalSetup` (SPEC §3.6).
 *
 * Databases with live connections are skipped unless asked for: on a shared
 * server those usually belong to a run that is still going, and taking them
 * out from under it would be worse than leaving a stale database behind.
 */
export async function pruneOrphans(options: PruneOptions): Promise<string[]> {
  assertValidPrefix(options.prefix)
  const applicationDatabase = databaseNameFromUrl(options.url)
  const dropped: string[] = []

  await withAdmin(options, async (admin) => {
    // `_` is a LIKE wildcard, so the prefix separator is escaped: this must
    // match our databases and nothing else.
    const rows = await admin.query(
      `SELECT d.datname AS name,
              (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessions
         FROM pg_database d
        WHERE d.datname LIKE $1 ESCAPE '\\'`,
      [likePatternFor(options.prefix)],
    )

    const keep = new Set(options.keep ?? [])
    for (const row of rows) {
      const name = String(row['name'])
      const sessions = Number(row['sessions'] ?? 0)
      if (name === applicationDatabase || SYSTEM_DATABASES.has(name)) continue
      if (keep.has(name)) {
        log(`keeping ${name}`)
        continue
      }
      if (sessions > 0 && options.includeActive !== true) {
        log(`skipping ${name}: ${sessions} live connection(s), another run may own it`)
        continue
      }
      try {
        if (await dropDatabase(admin, name, { prefix: options.prefix, applicationDatabase })) {
          dropped.push(name)
        }
      } catch (err) {
        warn(`could not prune the leftover database ${name}:`, err)
      }
    }
  })

  if (dropped.length > 0) log('pruned:', dropped.join(', '))
  return dropped
}
