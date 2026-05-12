/**
 * NullProvider — in-memory provider for tests and dev. Records every send
 * without dispatching anything. Inspect `.sent` to assert what would have
 * been delivered.
 */

import type { MailProvider, NormalizedEvent, SendArgs, SendResult } from '../../shared/types.js'

let counter = 0

export class NullProvider implements MailProvider {
  readonly name = 'null'
  readonly sendRatePerSecond = 1000
  public readonly sent: SendArgs[] = []

  async send(args: SendArgs): Promise<SendResult> {
    this.sent.push(args)
    return {
      providerId: `null-${Date.now()}-${++counter}`,
      status: 'accepted',
    }
  }

  async verifyWebhook(): Promise<boolean> {
    return true
  }

  parseWebhookEvents(): NormalizedEvent[] {
    return []
  }

  reset(): void {
    this.sent.length = 0
  }
}
