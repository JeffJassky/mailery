import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('admin UI loads with sidebar + dashboard', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await expect(page.getByText('Mailery').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText(/Send & open activity/i)).toBeVisible()
})

test('sidebar navigation switches screens', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.getByText('Flows', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible()
  await page.getByText('Templates', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible()
  await page.getByText('Suppressions', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Suppressions' })).toBeVisible()
})

test('theme toggle flips data-theme attribute', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTitle('Toggle theme').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
