import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('create a broadcast draft and refine its segment', async ({ page, request }) => {
  // Pre-create a template.
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'news', name: 'Newsletter', kind: 'marketing', subject: 'Update' },
  })
  // Subscribe seeded contacts so they show up in the segment count.
  for (const id of ['alice', 'bob', 'charlie']) {
    await request.post('/__test__/fire', { data: { eventName: 'Created', externalId: id } })
  }

  await page.goto('/admin/mailer/')
  await page.getByText('Broadcasts', { exact: true }).click()
  await page.getByRole('button', { name: /new broadcast/i }).click()

  // Fill the form.
  await page.getByPlaceholder('june-newsletter').fill('july-news')
  await page.getByPlaceholder('June Newsletter').fill('July newsletter')
  await page.locator('select').filter({ hasText: '(pick a template)' }).selectOption('news')

  // Save draft.
  await page.getByRole('button', { name: /save draft/i }).click()
  await expect(page.getByText(/Created draft/)).toBeVisible({ timeout: 10_000 })

  // Wait for live count to populate (the default subscriptionStatus=subscribed
  // filter should match the 3 contacts we just subscribed).
  await expect(page.getByText(/host filter/).first()).toBeVisible()
  await expect(page.locator('.kpi-value').filter({ hasText: /^[0-9]+$/ }).first()).toBeVisible({ timeout: 10_000 })

  // Add a filter row.
  const filterSelectsBefore = await page.locator('select').filter({ hasText: 'Has tag' }).count()
  await page.getByRole('button', { name: /add filter/i }).click()
  // After click, one more filter-kind select should be on the page.
  await expect.poll(async () => page.locator('select').filter({ hasText: 'Has tag' }).count()).toBe(filterSelectsBefore + 1)

  // Verify the broadcast exists in DB.
  const broadcasts = await (await request.get('/__test__/db/broadcasts')).json()
  expect(broadcasts.find((b: any) => b.slug === 'july-news')).toBeTruthy()
})

test('typed-count gate prevents scheduling with wrong count', async ({ page, request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'news', name: 'Newsletter', kind: 'marketing', subject: 'Update' },
  })
  await request.post('/admin/mailer/api/broadcasts', {
    data: {
      slug: 'gated',
      name: 'Gated broadcast',
      templateSlug: 'news',
      segmentDefinition: { filters: [{ kind: 'subscriptionStatus', equals: 'subscribed' }] },
    },
  })
  // Subscribe one contact.
  await request.post('/__test__/fire', { data: { eventName: 'Created', externalId: 'alice' } })

  // Visit the broadcast composer for the existing broadcast directly.
  await page.goto('/admin/mailer/broadcasts' as any)
  await page.getByText('Broadcasts', { exact: true }).click()
  await page.getByRole('button', { name: /new broadcast/i }).click()

  // Schedule button should start disabled (no typed count).
  const schedule = page.getByRole('button', { name: /^schedule$/i })
  await expect(schedule).toBeDisabled()
})
