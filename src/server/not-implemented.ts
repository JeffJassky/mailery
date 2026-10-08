/**
 * Placeholder thrown by 0.21 contract stubs (plans/15a-work-breakdown.md).
 * Every call site names the PR that replaces it; none may ship in a release.
 */
export function notImplemented(what: string, pr: 'PR2' | 'PR3' | 'PR4' | 'PR5'): never {
  throw new Error(`mailery 0.21: ${what} is not implemented yet (${pr})`)
}
