/**
 * Guarded lookup into the provider map.
 *
 * `Mailer.providers` is a plain object literal (`Record<string, MailProvider>`),
 * so a bare `providers[name]` also resolves inherited `Object.prototype`
 * members: `constructor`, `toString`, `valueOf` and friends all return
 * something truthy, sail past an `if (!provider)` guard, and reach
 * `provider.send(...)` / `provider.verifyWebhook(...)` as a non-provider.
 * `__proto__` resolves to the prototype object itself.
 *
 * Two gates, because either alone is incomplete: `Object.hasOwn` rejects
 * inherited keys, and the shape check rejects an own key whose value was never
 * a provider (a host building the map from untyped JSON, say).
 *
 * The shape check requires the *whole* `MailProvider` method surface rather
 * than just the methods a given call site is about to use. The map is typed
 * `Record<string, MailProvider>`; a value missing any of them was never a
 * provider, and having one lookup answer the same way everywhere is worth more
 * than letting a half-built object through on the routes that happen not to
 * touch its missing half.
 *
 * Lives here — a leaf module next to `mailer.ts`, importing nothing but a type
 * — so the public router, the admin router and the send runner can all share
 * it without any of them importing each other and without a cycle through
 * `mailer.ts` (which imports the runner).
 */

import type { MailProvider } from '../shared/types.js'

/** Methods that make a value a `MailProvider` rather than an arbitrary object. */
const PROVIDER_METHODS = ['send', 'verifyWebhook', 'parseWebhookEvents'] as const

function isMailProvider(candidate: unknown): candidate is MailProvider {
  if (!candidate || typeof candidate !== 'object') return false
  const p = candidate as Partial<Record<(typeof PROVIDER_METHODS)[number], unknown>>
  return PROVIDER_METHODS.every((m) => typeof p[m] === 'function')
}

/**
 * Resolve `name` against `providers`, or `null` when it does not name a
 * registered provider. Never throws, and never returns something that isn't a
 * provider — callers can go straight to a method call on a non-null result.
 */
export function resolveProvider(
  providers: Record<string, MailProvider>,
  name: unknown,
): MailProvider | null {
  if (typeof name !== 'string' || !Object.hasOwn(providers, name)) return null
  const candidate: unknown = providers[name]
  return isMailProvider(candidate) ? candidate : null
}

/**
 * Names that `resolveProvider` would actually resolve, sorted. For error
 * messages on admin-gated routes, where telling the operator what *is*
 * registered is the difference between a fixable report and a dead end.
 */
export function registeredProviderNames(providers: Record<string, MailProvider>): string[] {
  return Object.keys(providers)
    .filter((name) => resolveProvider(providers, name) !== null)
    .sort()
}
