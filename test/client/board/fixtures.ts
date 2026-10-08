import type { ProgramAction, ProgramDefinition } from '../../../src/shared/types'
import type { ProgramSimulation } from '../../../src/shared/program-board'

export const action = (id: string, priority: number, slugs: string[], extra: Partial<ProgramAction> = {}): ProgramAction => ({
  id,
  version: 1,
  title: id.toUpperCase(),
  priority,
  satisfied: { fact: 'done' } as any,
  attempts: slugs.map((s) => ({ deliveries: [{ channel: 'email' as const, templateSlug: s }] })),
  onExhaust: 'skip',
  ...extra,
})

export const def = (actions: ProgramAction[], extra: Partial<ProgramDefinition> = {}): ProgramDefinition => ({
  slug: 'p',
  name: 'P',
  category: 'marketing',
  subject: 'account',
  recipients: 'owners',
  entry: { eventName: 'Account Created' },
  exit: {},
  policy: { minGapDays: 3 },
  actions,
  ...extra,
})

export const sim = (over: Partial<ProgramSimulation<string>> = {}): ProgramSimulation<string> => ({
  source: 'draft',
  version: null,
  now: '2026-10-08T12:00:00.000Z',
  subjectId: 'acc1',
  facts: {},
  run: null,
  arm: 'treatment',
  candidates: [],
  next: { reason: 'send', actionId: null, attempt: null, templateSlug: null, at: null },
  sequence: [],
  sequenceEnd: 'completed',
  ...over,
})

export const cand = (actionId: string, extra: Record<string, unknown> = {}) => ({
  actionId,
  title: actionId.toUpperCase(),
  priority: 1,
  eligible: true,
  satisfied: false,
  blockedBy: null,
  status: 'pending' as const,
  attempts: 0,
  ladder: 1,
  cooldownUntil: null,
  ...extra,
})
