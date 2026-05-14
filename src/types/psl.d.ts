declare module 'psl' {
  export type ParsedDomain = {
    input: string
    tld: string | null
    sld: string | null
    domain: string | null
    subdomain: string | null
    listed: boolean
  }
  export type ErrorParsed = { input: string; error: { code: string; message: string } }
  export function parse(domain: string): ParsedDomain | ErrorParsed
  export function get(domain: string): string | null
  export function isValid(domain: string): boolean
  const psl: { parse: typeof parse; get: typeof get; isValid: typeof isValid }
  export default psl
}
