/**
 * Public exports for the `mailery` package.
 *
 * Phase 0 will add: Mailer (class), MongoContactAdapter, SendGridProvider.
 * See plans/10-public-api.md for the full surface.
 */

export const VERSION = '0.0.1'

export { createAdminRouter } from './api/admin.js'
export type { AdminRouterOptions } from './api/admin.js'

// Re-export shared types so consumers can import them from the top-level entry:
//   import type { Contact, FlowStep } from 'mailery'
export type * from '../shared/types.js'
