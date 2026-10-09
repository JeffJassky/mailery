/**
 * MemoryFactsAdapter — in-process FactsAdapter for tests (0.21).
 *
 *   const facts = new MemoryFactsAdapter({
 *     declare: { shopify_connected: { type: 'boolean' } },
 *   })
 *   facts.setSubject('acct1', { facts: { shopify_connected: false }, recipients: [alice] })
 *   facts.set('acct1', { shopify_connected: true })   // later: the user connected
 *
 * `resolveCalls` records every resolve, so a test can prove the dispatch-time
 * re-verify read fresh facts rather than the tick's snapshot.
 */

import type { Contact, FactDecl, Facts, FactsAdapter, RecipientRule } from '../shared/types.js'

export interface MemoryFactsSubject {
  facts?: Facts
  recipients?: Contact[]
}

export class MemoryFactsAdapter implements FactsAdapter {
  readonly declare: Record<string, FactDecl>
  readonly resolveCalls: Array<{ subjectId: string; at: Date }> = []
  readonly recipientCalls: Array<{ subjectId: string; rule: RecipientRule }> = []
  private readonly subjects = new Map<string, { facts: Facts; recipients: Contact[] }>()

  constructor(opts: { declare?: Record<string, FactDecl>; subjects?: Record<string, MemoryFactsSubject> } = {}) {
    this.declare = opts.declare ?? {}
    for (const [id, s] of Object.entries(opts.subjects ?? {})) this.setSubject(id, s)
  }

  setSubject(subjectId: string, s: MemoryFactsSubject): void {
    this.subjects.set(subjectId, { facts: { ...(s.facts ?? {}) }, recipients: [...(s.recipients ?? [])] })
  }

  /** Merge facts for a subject (creating it if needed). */
  set(subjectId: string, patch: Facts): void {
    const cur = this.subjects.get(subjectId) ?? { facts: {}, recipients: [] }
    cur.facts = { ...cur.facts, ...patch }
    this.subjects.set(subjectId, cur)
  }

  setRecipients(subjectId: string, recipients: Contact[]): void {
    const cur = this.subjects.get(subjectId) ?? { facts: {}, recipients: [] }
    cur.recipients = [...recipients]
    this.subjects.set(subjectId, cur)
  }

  async resolve(subjectId: string): Promise<Facts> {
    this.resolveCalls.push({ subjectId, at: new Date() })
    return { ...(this.subjects.get(subjectId)?.facts ?? {}) }
  }

  async recipients(subjectId: string, rule: RecipientRule): Promise<Contact[]> {
    this.recipientCalls.push({ subjectId, rule })
    return [...(this.subjects.get(subjectId)?.recipients ?? [])]
  }
}
