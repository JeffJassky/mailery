/**
 * E2E smoke for the deliverability features added in PR1-10.
 *
 *   Health screen — per-bucket table, DNSBL section, Postmaster + SNDS + DMARC sections render
 *   List hygiene — screen renders with buckets / KPI scaffold
 *   Template editor — Issues panel + Deliverability check card render
 *
 * Verifies the screens mount without exploding. Deeper interactions are
 * covered by the unit / integration tests against the underlying APIs.
 */

import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('Health screen renders all deliverability sections', async ({ page }) => {
  await page.goto('/admin/mailer/')
  // Sidebar item — use .first() because the SVG icon name 'Health' also
  // appears in aria-labels elsewhere; the sidebar item is the one we want.
  await page.locator('.sidebar-link', { hasText: /^Health$/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()

  // Per-bucket table header (the per-(senderDomain × kind) section from PR1).
  await expect(page.getByText(/Per-\(sender domain × kind\)/i)).toBeVisible()

  // DNSBL section (PR2).
  await expect(page.getByText(/DNS block lists/i)).toBeVisible()

  // Postmaster section (PR4).
  await expect(page.getByText(/Google Postmaster Tools/i)).toBeVisible()

  // SNDS section (PR5).
  await expect(page.getByText(/Microsoft SNDS/i)).toBeVisible()

  // DMARC section (PR6).
  await expect(page.getByText(/DMARC RUA reports/i)).toBeVisible()
})

test('List hygiene screen renders with engagement KPIs', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.getByText('List hygiene', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'List hygiene' })).toBeVisible()

  // KPI labels from src/client/screens/hygiene.tsx.
  await expect(page.getByText(/Subscribed contacts/i)).toBeVisible()
  await expect(page.getByText(/Engaged \(30d\)/i)).toBeVisible()
  await expect(page.getByText(/Inactive >180d/i)).toBeVisible()
  await expect(page.getByText(/Never engaged/i)).toBeVisible()

  // Sunset opportunity card heading.
  await expect(page.getByText(/Sunset opportunity/i)).toBeVisible()
})

test('Template editor shows Issues panel + Deliverability check card', async ({ page, request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'lint-e2e', name: 'Lint E2E', kind: 'marketing', subject: 'Hi' },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('Lint E2E').first().click()

  await expect(page.getByRole('heading', { name: 'Lint E2E' })).toBeVisible({ timeout: 15_000 })

  // Live-lint sidebar card (PR10).
  await expect(page.getByText('Issues', { exact: true })).toBeVisible()

  // Mail-Tester card (PR9). It always renders, even when not configured.
  await expect(page.getByText(/Deliverability check/i)).toBeVisible()
  await expect(page.getByText(/Mail-Tester not configured/i)).toBeVisible()
})

test('Health screen Resume button is hidden when no buckets are tripped', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.locator('.sidebar-link', { hasText: /^Health$/ }).first().click()
  // The header pill should show either "healthy" or "no telemetry"; "Resume all" only
  // shows when status is not 'healthy'.
  const resumeAll = page.getByRole('button', { name: /resume all/i })
  await expect(resumeAll).toHaveCount(0)
})

// plans/18-dmarc-monitoring.md PR 4. The e2e server mounts no inbound route and
// sets no onDmarcAlert, so every setup step that depends on them shows its
// "not yet" state.
test('DMARC Monitoring screen: setup, alerts, settings, test alert', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.locator('.sidebar-link', { hasText: /^Health$/ }).first().click()
  await page.getByRole('button', { name: 'Open DMARC Monitoring' }).click()
  await expect(page.getByRole('heading', { name: 'DMARC Monitoring' })).toBeVisible()

  await expect(page.getByText('Setup', { exact: true })).toBeVisible()
  await expect(page.getByText('Alerts', { exact: true })).toBeVisible()
  await expect(page.getByText('Settings', { exact: true })).toBeVisible()
  await expect(page.getByText(/dmarcInbound/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload report(s)' })).toBeVisible()
  await expect(page.getByText('No open alerts.')).toBeVisible()

  await page.getByRole('button', { name: 'Send test alert' }).click()
  await expect(page.getByText('No onDmarcAlert handler is configured')).toBeVisible()

  await page.getByLabel('Lookback window (days)').fill('14')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Reset to defaults' })).toBeVisible()
  await page.reload()
  await page.locator('.sidebar-link', { hasText: /^DMARC Monitoring$/ }).first().click()
  await expect(page.getByLabel('Lookback window (days)')).toHaveValue('14')
})
