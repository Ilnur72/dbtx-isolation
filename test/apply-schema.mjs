// Stands in for a real `migrate` command: dbtx runs it as a child process
// with DATABASE_URL pointing at the template database. Being a separate
// process, its `pg` is unpatched — which is the point.
import { readFile } from 'node:fs/promises'
import pgNamespace from 'pg'

const pg = pgNamespace.default ?? pgNamespace
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

await client.connect()
try {
  await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
} finally {
  await client.end()
}
