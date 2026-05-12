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

test('publish a Maily-authored template', async ({ page, request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'maily-test', name: 'Maily Test', kind: 'marketing', subject: 'Hi' },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('Maily Test').first().click()

  // Wait for the editor to mount.
  await expect(page.getByRole('heading', { name: 'Maily Test' })).toBeVisible({ timeout: 15_000 })

  // Edit subject so the draft is dirty.
  const subjectInput = page.locator('input').filter({ hasText: '' }).nth(0)
  await subjectInput.click()
  await subjectInput.fill('Updated subject for E2E')

  await page.getByRole('button', { name: /publish/i }).click()
  await expect(page.getByText(/Published v\d+/)).toBeVisible({ timeout: 15_000 })

  // Verify via REST.
  const tpl = await (await request.get('/admin/mailer/api/templates/maily-test')).json()
  expect(tpl.publishedAt).not.toBeNull()
  expect(tpl.body.html.length).toBeGreaterThan(0)
})
