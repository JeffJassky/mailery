/**
 * Sender-domain validator.
 *
 * Hosts may declare a `senderDomains` registry mapping a domain to which kind
 * of email is allowed to send from it. Used to isolate marketing reputation
 * from transactional reputation:
 *
 *   senderDomains: {
 *     'news.example.com': { kind: 'marketing' },
 *     'mail.example.com': { kind: 'transactional' },
 *     'tools.example.com': { kind: 'both' },     // OK for either kind
 *   }
 *
 * The check runs at template publish time. If a template's `fromEmail` domain
 * isn't declared, or is declared for the wrong kind, publish fails with a
 * descriptive 400. Hosts who don't set `senderDomains` get no enforcement —
 * back-compat default.
 */

import type { TemplateKind } from '../../shared/enums.js'

export interface SenderDomainConfig {
  /** Which template `kind` may use this domain as a From address. */
  kind: 'marketing' | 'transactional' | 'both'
}

export type SenderDomainRegistry = Record<string, SenderDomainConfig>

export type SenderDomainValidation =
  | { ok: true }
  | { ok: false; code: 'invalid_email' | 'unregistered_domain' | 'wrong_kind'; reason: string }

export function validateSenderDomain(
  fromEmail: string,
  templateKind: TemplateKind,
  registry: SenderDomainRegistry | undefined,
): SenderDomainValidation {
  if (!registry || Object.keys(registry).length === 0) return { ok: true }

  const domain = extractDomain(fromEmail)
  if (!domain) {
    return {
      ok: false,
      code: 'invalid_email',
      reason: `invalid fromEmail "${fromEmail}" — expected "name@domain"`,
    }
  }

  const entry = registry[domain]
  if (!entry) {
    const known = Object.keys(registry).join(', ')
    return {
      ok: false,
      code: 'unregistered_domain',
      reason: `sender domain "${domain}" is not declared in senderDomains (allowed: ${known})`,
    }
  }

  if (entry.kind === 'both') return { ok: true }
  if (entry.kind !== templateKind) {
    return {
      ok: false,
      code: 'wrong_kind',
      reason: `sender domain "${domain}" is configured for ${entry.kind} email, but this template's kind is ${templateKind}`,
    }
  }

  return { ok: true }
}

function extractDomain(email: string): string | null {
  if (typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase().trim()
}
