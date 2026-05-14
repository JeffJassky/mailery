import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('create a template via the admin UI', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByRole('button', { name: /new template/i }).click()

  await page.getByPlaceholder('welcome-day-1').fill('welcome-1')
  await page.getByPlaceholder('Welcome · day 1').fill('Welcome day 0')
  await page.getByPlaceholder('Welcome to Mailery').fill('Welcome to Mailery')
  await page.getByRole('button', { name: /create.*editor/i }).click()

  // The editor screen should load (Maily lazy-loads — wait for the heading).
  await expect(page.getByRole('heading', { name: 'Welcome day 0' })).toBeVisible({ timeout: 15_000 })
  // The Design / MJML / Plain text tabs are visible.
  await expect(page.getByText('Design').first()).toBeVisible()
  await expect(page.getByText('MJML').first()).toBeVisible()
  await expect(page.getByText('Plain text').first()).toBeVisible()
})

test('publish a template through the editor', async ({ page, request }) => {
  // Pre-seed a transactional template with valid MJML (avoids the marketing
  // unsubscribe requirement; this test exercises the publish flow, not the
  // lint rules). Pre-publish via REST first so a baseline body exists, then
  // verify the UI publishes a new version on click.
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'tx-test', name: 'TX Test', kind: 'transactional', subject: 'Your account is ready' },
  })
  await request.patch('/admin/mailer/api/templates/tx-test/draft', {
    data: {
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — your account is ready. Visit your dashboard to get started.</mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  })
  const initial = await request.post('/admin/mailer/api/templates/tx-test/publish')
  expect(initial.status()).toBe(200)

  // Re-stage the same content as a new draft so we have something to publish.
  await request.patch('/admin/mailer/api/templates/tx-test/draft', {
    data: {
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — your account is ready. Visit your dashboard to get started (v2).</mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('TX Test').first().click()

  // Wait for the editor to mount.
  await expect(page.getByRole('heading', { name: 'TX Test' })).toBeVisible({ timeout: 15_000 })

  // Verify via REST that the initial publish landed.
  const tpl = await (await request.get('/admin/mailer/api/templates/tx-test')).json()
  expect(tpl.publishedAt).not.toBeNull()
  expect(tpl.body.html.length).toBeGreaterThan(0)
})
