/**
 * Cloudflare DNS helpers shared by setup-sendgrid + setup-dmarc.
 * Wraps the v4 zones / dns_records endpoints with idempotent upsert.
 */

// Static, not `require()`: `inferZone` is synchronous, and tsup compiles a
// `require()` in a `"type": "module"` package to esbuild's `__require` shim,
// which throws in the ESM output (dist/cli.js). Same defect as #12.
import psl from 'psl'

export interface CloudflareClient {
  findZoneId(name: string): Promise<string | null>
  upsertRecord(zoneId: string, rec: { type: string; host: string; data: string }): Promise<'created' | 'updated' | 'noop'>
}

export function cloudflareClient(apiToken: string, fetchFn: typeof fetch): CloudflareClient {
  const base = 'https://api.cloudflare.com/client/v4'
  const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } })
    const body: any = await res.json().catch(() => null)
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Cloudflare rejected the request (HTTP ${res.status}). Your CLOUDFLARE_API_TOKEN is invalid, expired, ` +
          'or missing the required permissions. The token needs Zone:Read + DNS:Edit on the specific zone you\'re ' +
          'publishing into. Manage tokens at https://dash.cloudflare.com/profile/api-tokens.',
      )
    }
    if (!res.ok || (body && body.success === false)) {
      const message = body?.errors?.[0]?.message ?? res.statusText
      throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path} → ${res.status}: ${message}`)
    }
    return body
  }

  return {
    async findZoneId(name: string) {
      const r = await call(`/zones?name=${encodeURIComponent(name)}`)
      return r?.result?.[0]?.id ?? null
    },
    async upsertRecord(zoneId, rec) {
      const existing = await call(
        `/zones/${zoneId}/dns_records?type=${encodeURIComponent(rec.type)}&name=${encodeURIComponent(rec.host)}`,
      )
      const match = existing?.result?.[0]
      const desiredBody = {
        type: rec.type,
        name: rec.host,
        content: rec.data,
        ttl: 1,
        proxied: false,
      }
      if (!match) {
        await call(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(desiredBody) })
        return 'created'
      }
      // Cloudflare normalizes TXT record content by wrapping in double
      // quotes when the string contains spaces or punctuation. Long TXT
      // values (>255 chars, the DNS string-segment limit) are also
      // returned as a sequence of quoted segments separated by spaces:
      //   "v=DMARC1; p=quarantine; rua=..." "extra=stuff"
      // Strip *all* quoted segments and concat before comparing.
      const normalizeTxt = (s: string) => {
        if (rec.type !== 'TXT' || typeof s !== 'string') return s
        const re = /"((?:[^"\\]|\\.)*)"/g
        const segments: string[] = []
        let m: RegExpExecArray | null
        while ((m = re.exec(s))) segments.push(m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
        return segments.length > 0 ? segments.join('') : s
      }
      if (normalizeTxt(match.content) === rec.data && match.proxied === false) {
        return 'noop'
      }
      await call(`/zones/${zoneId}/dns_records/${match.id}`, {
        method: 'PUT',
        body: JSON.stringify(desiredBody),
      })
      return 'updated'
    },
  }
}

/**
 * Public Suffix List-aware eTLD+1 inference. Handles multi-label public
 * suffixes (`.co.uk`, `.com.br`, etc.) correctly. Falls back to the
 * original input if PSL can't classify the domain (e.g., private TLD).
 */
export function inferZone(domain: string): string {
  return psl.get(domain) ?? domain
}
