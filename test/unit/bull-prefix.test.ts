/**
 * Prefix validation for the Bull driver. Rejection happens before any Redis
 * connection is made, so no live Redis is needed.
 */

import { describe, it, expect } from 'vitest'

import { BullDriver } from '../../src/server/queues/bull.js'

describe('BullDriver queue prefix', () => {
  it('rejects a prefix containing ":"', async () => {
    await expect(
      BullDriver.create({ url: 'redis://127.0.0.1:6379' }, 'mailery:dev'),
    ).rejects.toThrow(/must not contain ':'/)
  })
})
