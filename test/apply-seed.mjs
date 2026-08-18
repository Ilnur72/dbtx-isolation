// Stands in for a real `seed` command: dbtx runs it once against the template,
// after the migration and before the template is sealed.
//
// The rows it inserts are what `test/fixture/seed.test.ts` asserts on. They are
// reference data — the kind every test expects to find and no test creates —
// which is exactly the case a `TRUNCATE`-everything cleanup destroys.
import pgNamespace from 'pg'

const pg = pgNamespace.default ?? pgNamespace
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

await client.connect()
try {
  await client.query(`INSERT INTO countries (code, name) VALUES
    ('UZ', 'Uzbekistan'), ('KZ', 'Kazakhstan'), ('KG', 'Kyrgyzstan')`)
} finally {
  await client.end()
}
