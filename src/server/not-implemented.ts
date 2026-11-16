/**
 * Placeholder thrown by contract stubs (0.21: plans/15a-work-breakdown.md; 0.22: plans/19a).
 * Every call site names the PR that replaces it; none may ship in a release.
 */
export function notImplemented(what: string, pr: 'PR2' | 'PR3' | 'PR4' | 'PR5'): never {
  throw new Error(`mailery: ${what} is not implemented yet (${pr})`)
}
