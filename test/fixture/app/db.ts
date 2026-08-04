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
