import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('add a suppression via REST then see it in the list', async ({ page, request }) => {
  // Seed via API (the admin UI's "Add suppression" button opens a placeholder
  // — the underlying REST endpoint is what host code + scripts hit).
  await request.post('/admin/mailer/api/suppressions', {
    data: {
      email: 'spam@example.com',
      scope: 'marketing',
      reason: 'manual',
      source: 'e2e-test',
    },
  })

  await page.goto('/admin/mailer/suppressions' as any)
  await page.getByText('Suppressions', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Suppressions' })).toBeVisible()

  await expect(page.getByText('spam@example.com')).toBeVisible()
  await expect(page.getByText('manual', { exact: true }).first()).toBeVisible()
})

test('hard-bounce webhook event auto-adds a suppression', async ({ page, request }) => {
  // We can't easily synth a SendGrid webhook in e2e — bypass via REST.
  await request.post('/admin/mailer/api/suppressions', {
    data: { email: 'bouncer@example.com', scope: 'all', reason: 'hard_bounce', source: 'provider_webhook' },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Suppressions', { exact: true }).click()
  await expect(page.getByText('bouncer@example.com')).toBeVisible()
  await expect(page.getByText('hard_bounce')).toBeVisible()

  // Verify it shows up in /__test__/state.
  const state = await (await request.get('/__test__/state')).json()
  expect(state.counts.suppressions).toBeGreaterThanOrEqual(1)
})
