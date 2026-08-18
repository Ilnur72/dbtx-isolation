// The application. It builds its pool at import time, which is the case that
// catches a runner arranging things too late.
import pgNamespace from 'pg'

const pg = (pgNamespace as unknown as { default?: typeof pgNamespace }).default ?? pgNamespace
export const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] })

export async function createUser(name: string): Promise<number> {
  const { rows } = await pool.query('INSERT INTO users (name) VALUES ($1) RETURNING id', [name])
  return (rows[0] as { id: number }).id
}

export async function countUsers(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
  return (rows[0] as { n: number }).n
}

export async function countCountries(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM countries')
  return (rows[0] as { n: number }).n
}

export async function createCountry(code: string, name: string): Promise<number> {
  const { rows } = await pool.query(
    'INSERT INTO countries (code, name) VALUES ($1, $2) RETURNING id',
    [code, name],
  )
  return (rows[0] as { id: number }).id
}
