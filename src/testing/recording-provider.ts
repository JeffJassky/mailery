/**
 * RecordingProvider — a `MailProvider` decorator that records every send and
 * then delegates to whatever it wraps.
 *
 * This is what lets one test suite run against two very different backends.
 * Wrapping `NullProvider` gives fast, offline, deterministic assertions;
 * wrapping `SendGridProvider` makes the *same* assertions run against the real
 * API, with real auth, real payload validation and (outside sandbox mode) real
 * delivery. Tests assert on the recording either way, so nothing is duplicated
 * between the two tiers.
 *
 *   const provider = new RecordingProvider(new NullProvider())
 *   ...
 *   expect(provider.sent[0]?.subject).toContain('Alice')     // SendArgs
 *   expect(provider.records[0]?.result?.status).toBe('accepted')
 *
 * `sent` is deliberately a bare `SendArgs[]`, matching `NullProvider.sent`, so
 * this drops in wherever the old harness provider was used. `records` carries
 * the richer per-call detail (result, error, duration) that the live tier needs.
 */

import type {
  MailProvider,
  NormalizedEvent,
  SendArgs,
  SendResult,
} from '../shared/types.js'

export interface SendRecord {
  args: SendArgs
  /** Provider result, or null when the call threw. */
  result: SendResult | null
  /** Error thrown by the wrapped provider, or null on success. */
  error: Error | null
  /** Wall-clock ms the wrapped `send` took. Meaningful for the live tier. */
  durationMs: number
  at: Date
}

export class RecordingProvider implements MailProvider {
  /** Every `SendArgs` handed to the provider, in call order. */
  readonly sent: SendArgs[] = []
  /** Same calls, with outcome attached. */
  readonly records: SendRecord[] = []

  constructor(readonly inner: MailProvider) {}

  get name(): string {
    return this.inner.name
  }

  get sendRatePerSecond(): number | undefined {
    return this.inner.sendRatePerSecond
  }

  async send(args: SendArgs): Promise<SendResult> {
    // Record the args before delegating: a provider that throws still tells us
    // what mailery *tried* to send, which is usually the thing under test.
    this.sent.push(args)
    const record: SendRecord = { args, result: null, error: null, durationMs: 0, at: new Date() }
    this.records.push(record)

    const startedAt = Date.now()
    try {
      const result = await this.inner.send(args)
      record.result = result
      return result
    } catch (err: any) {
      record.error = err instanceof Error ? err : new Error(String(err))
      throw err // preserve retry semantics — dispatchSend relies on the throw
    } finally {
      record.durationMs = Date.now() - startedAt
    }
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    return this.inner.verifyWebhook(rawBody, headers)
  }

  parseWebhookEvents(payload: unknown, headers: Record<string, string>): NormalizedEvent[] {
    return this.inner.parseWebhookEvents(payload, headers)
  }

  /** Last recorded send, or undefined. Sugar for the common single-send assertion. */
  get last(): SendArgs | undefined {
    return this.sent[this.sent.length - 1]
  }

  /** All sends addressed to `email` (case-insensitive). */
  toRecipient(email: string): SendArgs[] {
    const lower = email.toLowerCase()
    return this.sent.filter((s) => s.to.toLowerCase() === lower)
  }

  reset(): void {
    this.sent.length = 0
    this.records.length = 0
  }
}
