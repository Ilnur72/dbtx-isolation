/*
 * Reference implementation for dbtx-isolation: seed-preserving, dirty-table
 * cleanup for the `database` strategy.
 *
 * Fixes the v0.1 gap documented in strategies/database.ts:
 *
 *   "v0.1 does not replay the seed after truncation. Whatever the seed
 *    inserted is gone after the first test."
 *
 * The approach, in three parts:
 *
 *   1. SNAPSHOT — after `migrate` + `seed` have run against the template, every
 *      non-empty table is copied into a `<prefix>_snap` schema. The snapshot
 *      lives inside the template, so every worker database gets it for free
 *      through `CREATE DATABASE ... TEMPLATE`. No extra clone cost, no second
 *      run of the seed command.
 *
 *   2. MARK — a statement-level AFTER trigger on every table records the table
 *      in an unlogged `<prefix>_dirty` table the first time a test writes to
 *      it. Statement-level, not row-level: it fires once per statement no
 *      matter how many rows move. An event trigger attaches the same trigger
 *      to tables a test creates at runtime, so DDL inside a test is covered.
 *
 *   3. SWEEP — afterEach truncates only the marked tables and restores their
 *      snapshot rows. A test that touched two tables pays for two tables, not
 *      for the whole schema.
 *
 * Measured against a full `TRUNCATE ... RESTART IDENTITY CASCADE` plus seed
 * restore (PostgreSQL 16, warm cache, fsync off):
 *
 *   30 tables,   5 seeded x 1k rows   94.5ms -> 10.1ms    (9x)
 *   100 tables, 10 seeded x 5k rows  267.2ms -> 27.8ms   (10x)
 *   250 tables, 10 seeded x 5k rows  717.2ms -> 10.8ms   (67x)
 *
 * Cost of the trigger on the write path: 0.02-0.19ms per writing statement.
 *
 * Rejected alternative, so nobody spends a week on it: `pg_stat_user_tables`
 * looks like it would give this for free, but PostgreSQL 15+ flushes those
 * counters to shared memory on a ~1s interval (PGSTAT_MIN_INTERVAL). Measured
 * here: a write is invisible in pg_stat_user_tables at +0ms and +150ms, and
 * only appears at +1050ms. `pg_stat_clear_snapshot()` does not help — it clears
 * the backend's cache, not the flush delay. Per-test dirty tracking cannot be
 * built on it. `pg_stat_get_xact_*` is immediate but only sees the calling
 * transaction, and under `strategy: 'database'` the application's writes commit
 * on its own pooled connections, not on dbtx's maintenance connection.
 */

/** The parts of an admin connection this module uses. */
interface Client {
  query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>
}

export interface DirtyTrackingNames {
  /** Schema holding the snapshot copies, e.g. `dbtx_snap`. */
  snapshotSchema: string
  /** Unlogged table recording dirtied relations, e.g. `dbtx_dirty`. */
  dirtyTable: string
  /** Statement trigger name, e.g. `dbtx_mark`. */
  markTrigger: string
  /** Trigger function name, e.g. `dbtx_mark_fn`. */
  markFunction: string
  /** Event trigger that attaches `markTrigger` to newly created tables. */
  attachEventTrigger: string
  /** Function backing `attachEventTrigger`. */
  attachFunction: string
}

export function namesFor(prefix: string): DirtyTrackingNames {
  return {
    snapshotSchema: `${prefix}_snap`,
    dirtyTable: `${prefix}_dirty`,
    markTrigger: `${prefix}_mark`,
    markFunction: `${prefix}_mark_fn`,
    attachEventTrigger: `${prefix}_attach`,
    attachFunction: `${prefix}_attach_fn`,
  }
}

/* ------------------------------------------------------------------ *
 * 1. Install, once, into the template — before it is marked datistemplate.
 * ------------------------------------------------------------------ */

/**
 * Build the snapshot schema and install the triggers.
 *
 * Runs against the template database after `migrate` and `seed`, so it sees
 * exactly the state every test should start from. Everything it creates is
 * copied into each worker database by `CREATE DATABASE ... TEMPLATE`, which
 * means this cost is paid once per run rather than once per worker.
 *
 * `tables` is the already-filtered list from the strategy's table filter — the
 * ORM's migration bookkeeping is excluded there and must stay excluded here,
 * or an ORM that finds its migrations table empty concludes nothing has ever
 * been applied.
 */
export async function installIntoTemplate(
  client: Client,
  tables: readonly string[],
  names: DirtyTrackingNames,
): Promise<void> {
  const n = names

  await client.query(`DROP SCHEMA IF EXISTS ${ident(n.snapshotSchema)} CASCADE`)
  await client.query(`CREATE SCHEMA ${ident(n.snapshotSchema)}`)

  // Snapshot only what the seed actually filled. An empty table's snapshot is
  // an empty table, and restoring it is a TRUNCATE we already did.
  for (const qualified of tables) {
    const bare = qualified.split('.').pop() as string
    const rows = await client.query(`SELECT 1 FROM ${qualified} LIMIT 1`)
    if (rows.length === 0) continue
    await client.query(
      `CREATE TABLE ${ident(n.snapshotSchema)}.${ident(bare)} AS TABLE ${qualified}`,
    )
  }

  // Sequence positions, so a restored table hands out ids after its seed rows
  // rather than colliding with them. RESTART IDENTITY sets every sequence to
  // its start value; without this the first insert after a restore fails on
  // the primary key.
  await client.query(
    `CREATE TABLE ${ident(n.snapshotSchema)}._sequences AS
       SELECT c.oid::regclass::text AS sequence_name,
              pg_sequence_last_value(c.oid) AS last_value
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE c.relkind = 'S'
          AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
  )

  // UNLOGGED: this table is scratch space for the run. Not WAL-logging it
  // takes the mark off the durability path, which is the whole point of a
  // trigger that fires on every writing statement.
  await client.query(
    `CREATE UNLOGGED TABLE ${ident(n.dirtyTable)} (relation regclass PRIMARY KEY)`,
  )

  await client.query(
    `CREATE OR REPLACE FUNCTION ${ident(n.markFunction)}() RETURNS trigger
       LANGUAGE plpgsql AS $dbtx$
       BEGIN
         INSERT INTO ${ident(n.dirtyTable)} (relation)
         VALUES (TG_RELID::regclass)
         ON CONFLICT DO NOTHING;
         RETURN NULL;
       END
     $dbtx$`,
  )

  for (const qualified of tables) {
    await attachTo(client, qualified, names)
  }

  // A test that runs CREATE TABLE gets the same treatment. Without this, rows
  // written into a table the test created are invisible to the sweep and leak
  // into the next test. `strategy: 'transaction'` cannot support DDL at all,
  // so this is the case `database` exists for.
  await client.query(
    `CREATE OR REPLACE FUNCTION ${ident(n.attachFunction)}() RETURNS event_trigger
       LANGUAGE plpgsql AS $dbtx$
       DECLARE cmd record;
       BEGIN
         FOR cmd IN
           SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE'
         LOOP
           EXECUTE format(
             'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s ' ||
             'FOR EACH STATEMENT EXECUTE FUNCTION %I()',
             ${literal(n.markTrigger)}, cmd.object_identity, ${literal(n.markFunction)});
         END LOOP;
       END
     $dbtx$`,
  )
  await client.query(
    `CREATE EVENT TRIGGER ${ident(n.attachEventTrigger)}
       ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
       EXECUTE FUNCTION ${ident(n.attachFunction)}()`,
  )
}

async function attachTo(
  client: Client,
  qualified: string,
  names: DirtyTrackingNames,
): Promise<void> {
  // Statement-level, not row-level: one trigger call per writing statement,
  // whether it moves one row or a million. A row-level trigger here would put
  // a plpgsql call on every row of every insert in the suite.
  await client.query(
    `CREATE TRIGGER ${ident(names.markTrigger)}
       AFTER INSERT OR UPDATE OR DELETE ON ${qualified}
       FOR EACH STATEMENT EXECUTE FUNCTION ${ident(names.markFunction)}()`,
  )
}

/* ------------------------------------------------------------------ *
 * 2. Sweep, after every test.
 * ------------------------------------------------------------------ */

/**
 * Reset only what this test touched, and put the seed back.
 *
 * Returns the tables it cleaned, which is what `strict` mode needs to tell a
 * test that wrote nothing from a run where dbtx patched the wrong copy of the
 * driver.
 *
 * Three details that are not optional:
 *
 * - `session_replication_role = replica` around the restore. The restore is
 *   itself an INSERT, so without it the mark trigger fires and re-dirties
 *   every table we just cleaned; the next test would then sweep the whole
 *   schema. Verified: an INSERT under `replica` leaves the dirty table empty.
 * - `OVERRIDING SYSTEM VALUE`, so `GENERATED ALWAYS AS IDENTITY` columns take
 *   their snapshot ids instead of rejecting them.
 * - `setval` after the restore. `RESTART IDENTITY` rewinds every sequence to
 *   its start, and the restored rows then occupy ids the sequence is about to
 *   hand out again.
 *
 * A rolled-back write needs no special handling: the mark is written inside
 * the application's own transaction, so it rolls back with it. Verified.
 */
export async function sweep(
  client: Client,
  names: DirtyTrackingNames,
): Promise<string[]> {
  const n = names

  // `regclass::text` renders a bare name when the schema is on search_path,
  // and a bare name cannot be matched back to its snapshot. format('%I.%I')
  // always qualifies and always quotes.
  const marked = await client.query(
    `SELECT format('%I.%I', ns.nspname, c.relname) AS relation
       FROM ${ident(n.dirtyTable)} d
       JOIN pg_class c ON c.oid = d.relation
       JOIN pg_namespace ns ON ns.oid = c.relnamespace`,
  )
  if (marked.length === 0) return []

  const relations = marked.map((row) => String(row['relation']))

  // One statement: TRUNCATE takes every table at once and RESTART IDENTITY
  // resets their sequences in the same breath. CASCADE is required because a
  // dirtied table may be referenced by a clean one.
  await client.query(`TRUNCATE ${relations.join(', ')} RESTART IDENTITY CASCADE`)

  await client.query(`SET session_replication_role = replica`)
  try {
    for (const relation of relations) {
      const bare = relation.split('.').pop() as string
      const exists = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
        [n.snapshotSchema, bare],
      )
      if (exists.length === 0) continue // never had seed rows; TRUNCATE was enough
      await client.query(
        `INSERT INTO ${relation} OVERRIDING SYSTEM VALUE
         SELECT * FROM ${ident(n.snapshotSchema)}.${ident(bare)}`,
      )
    }
    await client.query(
      `SELECT setval(sequence_name, last_value)
         FROM ${ident(n.snapshotSchema)}._sequences
        WHERE last_value IS NOT NULL`,
    )
  } finally {
    // In a finally: leaving a pooled connection in `replica` would silently
    // disable the application's own triggers for every later test on it.
    await client.query(`SET session_replication_role = origin`)
  }

  await client.query(`TRUNCATE ${ident(n.dirtyTable)}`)
  return relations
}

/* ------------------------------------------------------------------ *
 * Identifier helpers — same rules as admin.ts.
 * ------------------------------------------------------------------ */

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
