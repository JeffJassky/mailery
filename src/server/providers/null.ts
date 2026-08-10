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

  /**
   * Fails closed. This provider has no signing key, so it can never establish
   * that an inbound payload is authentic — and a method whose entire job is to
   * reject unauthenticated input must not answer "yes" by default. Returning
   * `true` here would mean any unsigned body posted to the webhook route is
   * accepted as genuine whenever the null provider is registered, which is
   * exactly the dev/staging configuration where that is easiest to miss.
   *
   * Nothing is lost: `parseWebhookEvents()` returns `[]`, so there was never
   * any inbound behaviour to preserve. To exercise the inbound half locally,
   * use a provider that actually signs (see `test/README.md`).
   */
  async verifyWebhook(): Promise<boolean> {
    return false
  }

  parseWebhookEvents(): NormalizedEvent[] {
    return []
  }

  reset(): void {
    this.sent.length = 0
  }
}
