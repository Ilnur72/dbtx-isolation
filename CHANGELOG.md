# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Fixed

- **`strategy: 'database'` no longer destroys your seed data.** Cleanup
  truncated every table after each test, so the seed survived exactly one test:
  from the second test onward the suite ran against an empty database rather
  than a clean one. The failure was quiet — a test asserting on reference data
  passed on its own and failed once another test ran before it.

### Changed

- Cleanup under `strategy: 'database'` is now incremental. Building the template
  also snapshots the seeded rows into a `<prefix>_snap` schema and installs a
  statement-level trigger on every table. Both live inside the template, so each
  worker inherits them through `CREATE DATABASE ... TEMPLATE` and the seed
  command still runs exactly once per run. After each test only the tables that
  test wrote to are truncated and restored.

  Measured on PostgreSQL 16 against the previous full sweep: 110.7ms → 10.8ms
  (30 tables), 281.5ms → 28.3ms (100 tables), 1843.9ms → 165.9ms (100 tables
  with 50k seeded rows), 357.0ms → 12.1ms (250 tables). The trigger costs
  0.02–0.16ms per writing statement.

- Tables a test creates at runtime are tracked too: an event trigger on
  `ddl_command_end` attaches the same statement trigger to them, so rows written
  into a table created inside a test no longer leak into the next one.

- `TEMPLATE_EPOCH` is bumped to `dbtx@0.2.0`. Templates cached by 0.1 have no
  snapshot and are rebuilt rather than reused.

### Notes

Dirty tracking is not built on `pg_stat_user_tables`, which looks like it would
give it for free. PostgreSQL 15+ flushes those counters to shared memory on a
~1s interval, so a write is invisible there for about a second after it commits
— longer than truncating everything would have taken.
`pg_stat_get_xact_*` is immediate but only sees the calling transaction, and
under this strategy the application commits on its own pooled connections.

## [0.1.0]

Initial release.
