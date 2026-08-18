import { describe, expect, it } from 'vitest'
import { countCountries, createCountry, createUser } from './app/db.js'

// Only the `database` strategy: `seed` runs against the template, and
// `transaction` never builds one — it uses the developer's own database as it
// finds it. So under `transaction` these rows exist only if the developer
// seeded that database themselves, which the fixture deliberately does not do.
//
// The regression this file exists for: before v0.2 the `database` strategy
// truncated every table after each test, so the seed survived exactly one test
// and every test after the first ran against an empty database rather than a
// clean one. The failure is quiet — a test asserting on reference data passes
// on its own and fails when it is not first in the file.

const strategy = process.env['DBTX_FIXTURE_STRATEGY'] ?? 'transaction'

describe.runIf(strategy === 'database')('seed data under the database strategy', () => {
it('sees the seed data', async () => {
  expect(await countCountries()).toBe(3)
})

it('still sees the seed data after another test has run', async () => {
  expect(await countCountries()).toBe(3)
})

it('does not keep rows a test added to a seeded table', async () => {
  await createCountry('TJ', 'Tajikistan')
  expect(await countCountries()).toBe(4)
})

it('is back to just the seed rows', async () => {
  expect(await countCountries()).toBe(3)
})

it('cleans unseeded tables in the same pass', async () => {
  await createUser('bob')
  expect(await countCountries()).toBe(3)
})
})
