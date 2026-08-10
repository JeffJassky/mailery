/**
 * Replay-window helpers shared by provider webhook verification.
 *
 * A signature proves a payload came from the provider. It does not prove the
 * payload is *current* — a captured request replays forever unless the signed
 * timestamp is also checked for recency. Every provider that signs
 * `timestamp + body` (SendGrid today; Postmark/SES/Mailgun when they land)
 * needs the same window logic, so it lives here rather than in one adapter.
 *
 * Policy, per the maintainer's direction: on by default, overridable per
 * provider, explicitly disable-able for hosts whose proxy delays delivery.
 */

/**
 * Default replay window, in seconds, applied when a provider is constructed
 * without an explicit tolerance.
 *
 * 300s (5 minutes) is the conventional value — it's what Stripe's SDKs use as
 * their default tolerance, and it is comfortably wider than any plausible
 * NTP-synced clock drift or provider retry jitter while still shrinking a
 * "replayable forever" window down to a five-minute one.
 */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * Per-provider tolerance option: seconds, or `0` / `false` to disable the
 * freshness check entirely.
 */
export type WebhookToleranceOption = number | false

/**
 * Normalize the constructor option into a number of seconds, where `0` means
 * "disabled".
 *
 * Anything nonsensical (negative, NaN, Infinity) falls back to the default
 * rather than being read as "disabled" — a typo in config should not silently
 * turn the replay window off.
 */
export function resolveWebhookToleranceSeconds(
  option?: WebhookToleranceOption,
): number {
  if (option === false || option === 0) return 0
  if (option === undefined || option === null) return DEFAULT_WEBHOOK_TOLERANCE_SECONDS
  if (typeof option !== 'number' || !Number.isFinite(option) || option < 0) {
    return DEFAULT_WEBHOOK_TOLERANCE_SECONDS
  }
  return option
}

/**
 * Is a provider-supplied unix-seconds timestamp inside the replay window?
 *
 * Rejects in both directions: too old (the replay case) and too far in the
 * future (a forged or badly-skewed clock). Clock skew cuts both ways, so the
 * window is symmetric.
 *
 * Fails closed — a missing, empty, or non-integer timestamp is not fresh.
 * Returns a plain boolean so callers can fold it into an existing
 * "valid / not valid" decision without leaking *why* through an error.
 */
export function isWebhookTimestampFresh(
  rawTimestamp: string | undefined,
  toleranceSeconds: number,
  now: Date = new Date(),
): boolean {
  // Disabled: the caller opted out of the window. The signature still had to
  // cover this timestamp to get here, so nothing else is weakened.
  if (toleranceSeconds === 0) return true
  if (!rawTimestamp) return false

  // Strict digits-only parse. `Number()`/`parseInt` would happily accept
  // '  12 ', '1e12', '0x10', or '12abc' — none of which a provider sends, and
  // each of which widens what an attacker can put in the signed prefix.
  if (!/^\d{1,15}$/.test(rawTimestamp)) return false

  const timestampMs = Number(rawTimestamp) * 1000
  if (!Number.isFinite(timestampMs)) return false

  const deltaMs = Math.abs(now.getTime() - timestampMs)
  return deltaMs <= toleranceSeconds * 1000
}
