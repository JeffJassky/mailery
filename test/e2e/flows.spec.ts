import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('create a new flow from the admin UI', async ({ page }) => {
  await page.goto('/admin/mailer/')
  await page.getByText('Flows', { exact: true }).click()
  await page.getByRole('button', { name: /new flow/i }).click()

  await page.getByPlaceholder('welcome-series').fill('welcome')
  await page.getByPlaceholder('Welcome Series').fill('Welcome flow')
  await page.getByPlaceholder('Created').fill('Created')
  await page.getByRole('button', { name: /create.*draft/i }).click()

  // List should now show the new flow.
  await expect(page.getByText('Welcome flow').first()).toBeVisible()
  await expect(page.locator('.mono', { hasText: 'welcome' }).first()).toBeVisible()
})

test('add a wait + send step to a flow draft + save', async ({ page, request }) => {
  // Create a template + a flow up-front via REST so we can focus on the editor.
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'welcome-1', name: 'Welcome day 0', kind: 'marketing', subject: 'Hi' },
  })
  await request.post('/admin/mailer/api/flows', {
    data: { slug: 'welcome', name: 'Welcome flow', trigger: { eventName: 'Created' }, goal: 'activation' },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Flows', { exact: true }).click()
  await page.getByText('Welcome flow').first().click()

  await expect(page.getByText(/0 steps · click to edit/)).toBeVisible()

  // Open the first "+ insert step" picker.
  await page.getByTitle('Insert step').first().click()
  await page.getByRole('button', { name: 'Wait' }).click()
  await expect(page.getByText(/1 steps/)).toBeVisible()

  // Edit the wait duration.
  const valueInput = page.locator('input[type=number]').first()
  await valueInput.fill('3')
  // Change the unit.
  await page.locator('select').filter({ hasText: 'days' }).first().selectOption('hours')

  // Add a send step after.
  await page.getByTitle('Insert step').nth(1).click()
  await page.getByRole('button', { name: 'Send' }).click()
  // The template picker should list our template.
  const tplSelect = page.locator('select').filter({ hasText: /welcome-1/ })
  await expect(tplSelect).toBeVisible()

  // Save draft.
  await page.getByRole('button', { name: /save draft/i }).click()
  await expect(page.getByText(/^Saved$/)).toBeVisible({ timeout: 10_000 })

  // Verify via state.
  const flows = await (await request.get('/__test__/db/flows')).json()
  expect(flows[0].draft.steps).toHaveLength(2)
  expect(flows[0].draft.steps[0]).toMatchObject({ type: 'wait', value: 3, unit: 'hours' })
  expect(flows[0].draft.steps[1]).toMatchObject({ type: 'send' })
})

test('publish a flow with a send step', async ({ page, request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'hi', name: 'Hi', kind: 'marketing', subject: 'Hi' },
  })
  await request.post('/admin/mailer/api/flows', {
    data: { slug: 'hi-flow', name: 'Hi flow', trigger: { eventName: 'Created' } },
  })
  await request.patch('/admin/mailer/api/flows/hi-flow/draft', {
    data: { steps: [{ type: 'send', templateSlug: 'hi' }] },
  })

  await page.goto('/admin/mailer/')
  await page.getByText('Flows', { exact: true }).click()
  await page.getByText('Hi flow').first().click()

  await page.getByRole('button', { name: /publish/i }).click()
  await expect(page.getByText(/Published v1/)).toBeVisible({ timeout: 10_000 })
})
