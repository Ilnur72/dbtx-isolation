import { expect, it } from 'vitest'
import { countUsers, createUser } from './app/db.js'

// A second file: proves isolation holds across files, not just within one.
it('is also empty here', async () => {
  expect(await countUsers()).toBe(0)
})

it('and starts its ids at 1 too', async () => {
  expect(await createUser('bob')).toBe(1)
})
