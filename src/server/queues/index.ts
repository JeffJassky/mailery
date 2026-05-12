/**
 * Queue subsystem entry point. Exports the driver interface, the three
 * built-in drivers (Bull, Agenda, Noop), and a factory that resolves a
 * `QueueDriverConfig` to a concrete driver.
 */

import type { Db } from 'mongodb'

import { BullDriver } from './bull.js'
import { AgendaDriver } from './agenda.js'
import { NoopDriver } from './noop.js'
import type { QueueDriver, QueueDriverConfig } from './types.js'

export { BullDriver } from './bull.js'
export { AgendaDriver } from './agenda.js'
export { NoopDriver } from './noop.js'
export type {
  AddOptions,
  QueueAPI,
  QueueDriver,
  QueueDriverConfig,
  QueueHandlers,
  Queues,
  WorkerStartOptions,
} from './types.js'

export async function createQueueDriver(
  config: QueueDriverConfig,
  fallbackDb: Db,
): Promise<QueueDriver> {
  switch (config.driver) {
    case 'bull':
      return BullDriver.create(config.redis)
    case 'agenda':
      return AgendaDriver.create({
        db: config.db ?? fallbackDb,
        processEverySeconds: config.processEverySeconds,
        lockLifetimeSeconds: config.lockLifetimeSeconds,
        collectionName: config.collectionName,
      })
    case 'noop':
      return new NoopDriver()
    default: {
      const _exhaustive: never = config
      void _exhaustive
      throw new Error(`mailery: unknown queue driver`)
    }
  }
}
