/**
 * Sunset and gap arithmetic shared by the tick and the dispatch hooks (§5.8).
 */

import type { ProgramAction, ProgramDefinition } from '../../../shared/types.js'
import { DAY_MS } from './common.js'

/** Stage implied by the unanswered count: 0 normal, 1 slow, 2 ask. Always 0 without `policy.sunset`. */
export function sunsetStageFor(def: ProgramDefinition, unanswered: number): 0 | 1 | 2 {
  const s = def.policy.sunset
  if (!s) return 0
  if (unanswered >= s.askAfter) return 2
  if (unanswered >= s.slowAfter) return 1
  return 0
}

/**
 * Gap before the attempt at index `attemptIndex` of `action` (or the program
 * gap when `action` is undefined, e.g. the sunset ask), widened by
 * `slowFactor` at stage ≥ 1. With `progress` (an action completed or a human
 * click since the last send) and `policy.progressGapDays` set, the gap is the
 * smaller of the two (plans/17 F4).
 */
export function gapMs(
  def: ProgramDefinition,
  action: ProgramAction | undefined,
  attemptIndex: number,
  stage: number,
  progress = false,
): number {
  void progress // plans/17 F4: implemented in PR B
  const days = action?.attempts[attemptIndex]?.minGapDays ?? def.policy.minGapDays
  const factor = stage >= 1 && def.policy.sunset ? def.policy.sunset.slowFactor : 1
  return days * DAY_MS * factor
}
