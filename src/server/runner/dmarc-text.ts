/**
 * Report contents are attacker-supplied (anyone can email the rua mailbox), and
 * alert text is forwarded to Slack or email as is. plans/18-dmarc-monitoring.md §6.3a.
 */

const UNSAFE = /[\u0000-\u001f\u007f<>]+/g

/** Remove control characters and angle brackets, collapse whitespace, cap length. */
export function cleanReportText(value: unknown, max = 200): string {
  return String(value ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
