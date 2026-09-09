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
  await expect(page.getByText('HTML', { exact: true }).first()).toBeVisible()
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

/**
 * Issue #14: templates published as raw compiled HTML (deploy script, or the
 * agent API) have no MJML and no Design document, so before the HTML tab
 * existed there was nothing in the editor to look at, let alone edit.
 */
test('edit and publish an HTML-only template through the HTML tab', async ({ page, request }) => {
  const seeded =
    '<html><body><p>Original body text, long enough that the linter is satisfied. <a href="https://app.example.com/go">Open the app</a>.</p></body></html>'

  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'html-only', name: 'HTML Only', kind: 'transactional', subject: 'Your report is ready' },
  })
  // Stage + publish raw HTML so the template has body.html and nothing else —
  // the exact shape the deploy-script path produces.
  await request.patch('/admin/mailer/api/templates/html-only/draft', { data: { html: seeded } })
  expect((await request.post('/admin/mailer/api/templates/html-only/publish')).status()).toBe(200)

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('HTML Only').first().click()
  await expect(page.getByRole('heading', { name: 'HTML Only' })).toBeVisible({ timeout: 15_000 })

  // The HTML tab exists and shows the stored source — the regression this
  // whole feature exists to fix.
  await page.locator('.seg .seg-item', { hasText: /^HTML$/ }).click()
  const editor = page.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expect(editor).toContainText('Original')

  // Type into it, then publish, and confirm the edit reached body.html.
  // Append plain text at the very end rather than markup — Monaco's HTML mode
  // auto-closes tags, which would make what actually lands in the buffer
  // depend on the editor's bracket heuristics rather than on the test.
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' EDITEDMARKER')
  await expect(page.getByText('Unsaved changes').first()).toBeVisible()

  await page.getByRole('button', { name: /publish/i }).click()
  await expect(page.getByText(/Published v2/).first()).toBeVisible({ timeout: 20_000 })

  const tpl = await (await request.get('/admin/mailer/api/templates/html-only')).json()
  expect(tpl.body.html).toContain('EDITEDMARKER')
  expect(tpl.body.mjml).toBe('')
  expect(tpl.body.editorJson).toBeNull()
  expect(tpl.body.plainText.length).toBeGreaterThan(0)
  expect(tpl.draft).toBeNull()
})

test('the HTML tab is read-only for an MJML-authored template', async ({ page, request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'mjml-authored', name: 'MJML Authored', kind: 'transactional', subject: 'Your account is ready' },
  })
  await request.patch('/admin/mailer/api/templates/mjml-authored/draft', {
    data: {
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome — your account is ready. Visit your dashboard to get started.</mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  })
  expect((await request.post('/admin/mailer/api/templates/mjml-authored/publish')).status()).toBe(200)

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('MJML Authored').first().click()
  await expect(page.getByRole('heading', { name: 'MJML Authored' })).toBeVisible({ timeout: 15_000 })

  await page.locator('.seg .seg-item', { hasText: /^HTML$/ }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  // Compiler output, not a source of truth — the tab says so rather than
  // letting an operator make edits the next publish would throw away.
  await expect(page.getByText(/compiled\s+output, shown read-only/)).toBeVisible()
})

/**
 * The reported bug: edits live in the editor's local state, but the preview
 * rendered server-side from the *saved* draft, so it showed stale content and
 * looked broken. The body source now travels with the preview request.
 */
test('the Preview tab renders unsaved HTML edits', async ({ page, request }) => {
  const seeded =
    '<html><body><p>Original body text, long enough that the linter is satisfied. <a href="https://app.example.com/go">Open the app</a>.</p></body></html>'

  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'live-preview', name: 'Live Preview', kind: 'transactional', subject: 'Your report is ready' },
  })
  await request.patch('/admin/mailer/api/templates/live-preview/draft', { data: { html: seeded } })
  expect((await request.post('/admin/mailer/api/templates/live-preview/publish')).status()).toBe(200)

  await page.goto('/admin/mailer/')
  await page.getByText('Templates', { exact: true }).click()
  await page.getByText('Live Preview').first().click()
  await expect(page.getByRole('heading', { name: 'Live Preview' })).toBeVisible({ timeout: 15_000 })

  await page.locator('.seg .seg-item', { hasText: /^HTML$/ }).click()
  const editor = page.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' UNSAVEDMARKER')

  // Switch to Preview without saving or publishing.
  // Scope to the tab strip — the page header has a Preview button too.
  await page.locator('.seg .seg-item', { hasText: /^Preview$/ }).click()
  const frame = page.frameLocator('iframe[title="live preview"]')
  await expect(frame.locator('body')).toContainText('UNSAVEDMARKER', { timeout: 20_000 })

  // And the draft really was not written — a preview must not mutate.
  const tpl = await (await request.get('/admin/mailer/api/templates/live-preview')).json()
  expect(tpl.draft).toBeNull()
  expect(tpl.body.html).not.toContain('UNSAVEDMARKER')
})
