/**
 * Dry-run of the Program tick plus a projected send sequence (board).
 * plans/16-program-board.md §3. READ-ONLY: no writes to any collection, no
 * queue jobs, no lease. The only host calls are `factsAdapter.resolve` (subject
 * mode) and `factsAdapter.recipients` (subject mode, when the gates reach
 * step 13).
 */

import type { ProgramSimulation, ProgramSimulationInput } from '../../../shared/program-board.js'
import type { RunnerContext } from '../index.js'

export type ProgramSimulationErrorCode = 'not_found' | 'no_definition' | 'no_facts_adapter' | 'invalid_input'

export class ProgramSimulationError extends Error {
  constructor(readonly code: ProgramSimulationErrorCode, message: string) {
    super(message)
    this.name = 'ProgramSimulationError'
  }
}

export async function simulateProgram(
  ctx: RunnerContext,
  slug: string,
  input: ProgramSimulationInput = {},
): Promise<ProgramSimulation> {
  void ctx
  void slug
  void input
  throw new Error('simulateProgram: not implemented (board WP-A)')
}
