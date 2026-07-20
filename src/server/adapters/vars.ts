/**
 * VarsAdapter — host-provided template variables, resolved at render time.
 *
 * The host declares a zod schema (the contract templates can rely on) plus a
 * `resolve` function that loads those values from the host's own database for
 * a given contact. Resolved keys are merged into the render context root, so
 * a schema key `user` is referenced in templates as `{{user.name}}`.
 *
 * The schema does double duty: it is exposed to the admin SPA as JSON Schema
 * (GET /vars-schema) to drive editor autocomplete, and the content linter
 * uses it to flag `{{paths}}` that don't exist.
 */

import { z } from 'zod'

import type { Contact } from '../../shared/types.js'

export interface VarsResolveInfo {
  /** Why the vars are being resolved. Previews and tests should be side-effect free. */
  reason: 'send' | 'preview' | 'test'
  /** Slug of the template being rendered, when known. */
  templateSlug?: string
  /** Slug of the flow the send belongs to, when the render is part of a flow run. */
  flowSlug?: string
  /** Name of the event that triggered the flow run, when applicable. */
  eventName?: string
  /**
   * Properties of the triggering event (`mailer.fire(name, id, properties)`).
   * This is how a resolver scopes lookups for account/topic flows:
   * `info.eventProperties?.accountId` tells it WHICH account the run is about.
   * Also available raw in templates as `{{event.*}}`.
   */
  eventProperties?: Record<string, unknown>
}

export interface VarsAdapter<S extends z.ZodType = z.ZodType> {
  /** Contract for what `resolve` returns. Root keys become root template variables. */
  schema: S
  /** Load the variables for one contact from the host's data. */
  resolve(contact: Contact, info: VarsResolveInfo): Promise<z.infer<S>> | z.infer<S>
}

/**
 * Identity helper that pins `resolve`'s return type to `z.infer<schema>` —
 * without it, TypeScript widens the schema generic and the return type is
 * unchecked.
 *
 *   const varsAdapter = defineVars({
 *     schema: z.object({ user: z.object({ name: z.string() }) }),
 *     async resolve(contact) {
 *       return { user: { name: await lookupName(contact.externalId) } }
 *     },
 *   })
 */
export function defineVars<S extends z.ZodType>(adapter: VarsAdapter<S>): VarsAdapter<S> {
  return adapter
}

/**
 * Render-context keys mailery owns. Resolved vars never override these — a
 * schema that declares one is rejected at Mailer.init.
 */
export const RESERVED_VAR_KEYS = [
  'contact',
  'vars',
  'event',
  'unsubscribeUrl',
  'viewInBrowserUrl',
  'preferenceCenterUrl',
  'senderAddress',
] as const

/**
 * Throw if the schema's root keys collide with reserved render-context keys.
 * Called once at Mailer.init — fail fast, not per send.
 */
export function assertNoReservedVarKeys(adapter: VarsAdapter): void {
  const json = varsJsonSchema(adapter)
  const props = json && typeof json === 'object' ? (json as any).properties : undefined
  if (!props) return
  const clashes = RESERVED_VAR_KEYS.filter((k) => k in props)
  if (clashes.length > 0) {
    throw new Error(
      `varsAdapter schema declares reserved key(s): ${clashes.join(', ')}. ` +
        `These names are provided by mailery itself — rename them in your schema.`,
    )
  }
}

/** JSON Schema for the adapter's zod schema (wire format for the admin SPA + linter). */
export function varsJsonSchema(adapter: VarsAdapter): Record<string, unknown> {
  return z.toJSONSchema(adapter.schema, { io: 'output' }) as Record<string, unknown>
}

/**
 * Resolve vars for a contact, or `{}` when no adapter is configured.
 * Errors propagate to the caller — send paths let the queue retry, preview
 * paths surface the message to the operator.
 */
export async function resolveVars(
  adapter: VarsAdapter | undefined,
  contact: Contact,
  info: VarsResolveInfo,
): Promise<Record<string, unknown>> {
  if (!adapter) return {}
  const resolved = await adapter.resolve(contact, info)
  if (!resolved || typeof resolved !== 'object') return {}
  // Belt-and-braces: drop reserved keys even if the init-time assert was
  // bypassed (e.g. a hand-built adapter object with a lying schema).
  const out: Record<string, unknown> = { ...(resolved as Record<string, unknown>) }
  for (const k of RESERVED_VAR_KEYS) delete out[k]
  return out
}
