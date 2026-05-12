/**
 * Event registry + dedupe-key policy. INVARIANT 1: every `mailer_events` row
 * has a unique dedupeKey. Callers either pass one or `mailer.registerEvent`
 * declares a policy and we derive it.
 */

import crypto from 'node:crypto'

export type DedupePolicy = 'once-per-contact' | 'once-per-day' | 'every-time'

export interface EventRegistration {
  name: string
  dedupePolicy: DedupePolicy
}

export class EventRegistry {
  private readonly policies = new Map<string, DedupePolicy>()

  register(reg: EventRegistration): void {
    this.policies.set(reg.name, reg.dedupePolicy)
  }

  has(name: string): boolean {
    return this.policies.has(name)
  }

  policy(name: string): DedupePolicy | undefined {
    return this.policies.get(name)
  }

  /**
   * Derive a dedupeKey for an event call. Returns null when no policy is
   * registered AND no key was passed — caller should throw.
   */
  deriveKey(
    name: string,
    externalId: string,
    passedKey: string | undefined,
    now: Date,
  ): string | null {
    if (passedKey) return passedKey
    const policy = this.policies.get(name)
    if (!policy) return null

    switch (policy) {
      case 'once-per-contact':
        return `${externalId}:${name}`
      case 'once-per-day':
        return `${externalId}:${name}:${isoDay(now)}`
      case 'every-time':
        return `${externalId}:${name}:${randomId()}`
    }
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function randomId(): string {
  return crypto.randomBytes(8).toString('hex')
}
