import { expect, it } from 'vitest'
import { dbtx } from 'dbtx-isolation'
import { countUsers, createUser } from './app/db.js'

// No hooks, no helpers, no imports from dbtx needed for isolation itself.
it('starts empty', async () => {
  expect(await countUsers()).toBe(0)
})

it('writes a row, and the id starts at 1', async () => {
  expect(await createUser('alice')).toBe(1)
  expect(await countUsers()).toBe(1)
})

it('does not see the row from the previous test', async () => {
  expect(await countUsers()).toBe(0)
  expect(dbtx.isolated).toBe(true)
  expect(dbtx.depth).toBe(0)
})
