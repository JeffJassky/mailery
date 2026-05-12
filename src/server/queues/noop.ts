/**
 * No-op queue driver. Used by tests and by hosts that drive the runner
 * synchronously (no background workers, no Redis, no Agenda). `add()` is a
 * no-op; the caller is expected to invoke runner functions directly.
 */

import type {
  QueueAPI,
  QueueDriver,
  Queues,
  WorkerStartOptions,
} from './types.js'

function noopQueueAPI(): QueueAPI {
  return {
    add: async () => undefined,
    getWaitingCount: async () => 0,
    close: async () => undefined,
  }
}

export class NoopDriver implements QueueDriver {
  readonly queues: Queues = {
    tick: noopQueueAPI(),
    advance: noopQueueAPI(),
    send: noopQueueAPI(),
    webhook: noopQueueAPI(),
  }

  async scheduleRepeatingTick(_intervalSeconds: number): Promise<void> {
    /* noop */
  }

  async startWorkers(_opts: WorkerStartOptions): Promise<void> {
    /* noop */
  }

  async stopWorkers(): Promise<void> {
    /* noop */
  }

  async close(): Promise<void> {
    /* noop */
  }
}
