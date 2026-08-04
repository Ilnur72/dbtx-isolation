import type { DbtxConfig, ResolvedConfig } from '../types.js'

/** Default value for `DbtxConfig.prefix`. */
export const DEFAULT_PREFIX = 'dbtx'

/**
 * A prefix becomes part of Postgres identifiers (database names, savepoint
 * names), so it is restricted to lowercase identifier characters and kept
 * short enough that everything derived from it stays inside the 63-byte limit.
 */
export const PREFIX_PATTERN = /^[a-z_][a-z0-9_]{0,20}$/

/** Postgres truncates identifiers beyond this many bytes (`NAMEDATALEN - 1`). */
export const MAX_IDENTIFIER_BYTES = 63

/**
 * Mixed into the template fingerprint. Bump it whenever a dbtx change alters
 * what ends up inside a template, so cached templates from older versions are
 * rebuilt rather than reused.
 */
export const TEMPLATE_EPOCH = 'dbtx@0.1.0'

/**
 * Worst case widths for the parts appended to a prefix, used to prove at
 * config time that no identifier can outgrow the limit later in the run:
 * `<prefix>_<poolId>_<counter>_sp_<depth>`.
 */
const WORST_CASE_SUFFIX = `_${'9'.repeat(4)}_${'9'.repeat(9)}_sp_${'9'.repeat(6)}`

/** Throw unless `prefix` is safe to embed in a Postgres identifier. */
export function assertValidPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `dbtx: invalid prefix ${JSON.stringify(prefix)}. It becomes part of Postgres ` +
        `identifiers, so it must match ${String(PREFIX_PATTERN)} — lowercase, starting ` +
        `with a letter or underscore, at most 21 characters.`,
    )
  }
  // Checked once here rather than only per generated name, so a prefix can
  // never start failing halfway through a run as the context counter grows.
  assertIdentifierFits(`${prefix}${WORST_CASE_SUFFIX}`)
}

/**
 * Throw if a generated identifier would be silently truncated by Postgres.
 * Truncation is the dangerous failure here: two distinct databases or
 * savepoints could collapse onto one name.
 */
export function assertIdentifierFits(identifier: string): string {
  const bytes = Buffer.byteLength(identifier, 'utf8')
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `dbtx: generated identifier ${JSON.stringify(identifier)} is ${bytes} bytes, over ` +
        `the Postgres limit of ${MAX_IDENTIFIER_BYTES}. Postgres would truncate it, which ` +
        `can make two names collide. Use a shorter \`prefix\`.`,
    )
  }
  return identifier
}

/**
 * Migration bookkeeping tables, which the `database` strategy must never
 * truncate: an ORM that finds them empty concludes no migration has ever run
 * (SPEC §5). `%` is a wildcard.
 */
export const DEFAULT_EXCLUDED_TABLES: readonly string[] = [
  '_prisma%',
  '__drizzle_migrations',
  'drizzle.%',
  'knex_migrations',
  'knex_migrations_lock',
  'migrations',
  'mikro_orm_migrations',
  'typeorm_metadata',
  'typeorm_migrations',
  'schema_migrations',
  'sequelizemeta',
]

/** Apply defaults and validate. The single place a prefix is checked. */
export function resolveConfig(config: DbtxConfig): ResolvedConfig {
  const prefix = config.prefix ?? DEFAULT_PREFIX
  assertValidPrefix(prefix)
  if (config.cacheTemplate !== undefined && config.cacheTemplate.files.length === 0) {
    throw new Error(
      'dbtx: cacheTemplate.files cannot be empty. Without files to hash there is no ' +
        'honest way to tell whether the cached template is stale, so leave cacheTemplate ' +
        'off and the template will be rebuilt each run.',
    )
  }
  return {
    ...config,
    strategy: config.strategy ?? 'transaction',
    resetSequences: config.resetSequences ?? false,
    strict: config.strict ?? false,
    excludeTables: config.excludeTables ?? [],
    keepDatabases: config.keepDatabases ?? false,
    prefix,
  }
}
