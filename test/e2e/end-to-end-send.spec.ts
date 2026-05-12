/**
 * Full pipeline: subscribe a contact → fire an event → trigger scan creates
 * a flow_run → step processed → send dispatched through NullProvider.
 *
 * Uses the /__test__/tick endpoint to drive the runner inline (queueless harness).
 */

import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/__test__/reset')
})

test('fire event → flow advances → send goes through NullProvider', async ({ request }) => {
  // 1. Create a template + a published flow via REST.
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'welcome-1', name: 'Welcome', kind: 'marketing', subject: 'Hi {{contact.fields.firstName}}' },
  })
  // Patch the draft so it has actual MJML, then publish.
  await request.patch('/admin/mailer/api/templates/welcome-1/draft', {
    data: {
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{contact.fields.firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  })
  await request.post('/admin/mailer/api/templates/welcome-1/publish')

  await request.post('/admin/mailer/api/flows', {
    data: { slug: 'welcome', name: 'Welcome', trigger: { eventName: 'Created' } },
  })
  await request.patch('/admin/mailer/api/flows/welcome/draft', {
    data: { steps: [{ type: 'send', templateSlug: 'welcome-1' }] },
  })
  await request.post('/admin/mailer/api/flows/welcome/publish')

  // 2. Fire the event for one of the seeded contacts.
  await request.post('/__test__/fire', { data: { eventName: 'Created', externalId: 'alice' } })

  // 3. Drive the runner.
  await request.post('/__test__/tick')

  // 4. Assert the send fired through NullProvider.
  const state = await (await request.get('/__test__/state')).json()
  expect(state.sent.length).toBe(1)
  expect(state.sent[0].to).toBe('alice@example.com')
  expect(state.sent[0].subject).toContain('Alice')

  // The Send doc should be in `sent` status.
  const sends = await (await request.get('/__test__/db/sends')).json()
  expect(sends).toHaveLength(1)
  expect(sends[0].status).toBe('sent')
})

test('idempotent: firing the same event twice does not duplicate the run', async ({ request }) => {
  await request.post('/admin/mailer/api/templates', {
    data: { slug: 'hi', name: 'Hi', kind: 'marketing', subject: 'Hi' },
  })
  await request.patch('/admin/mailer/api/templates/hi/draft', {
    data: { mjml: '<mjml><mj-body><mj-text>Hi</mj-text></mj-body></mjml>' },
  })
  await request.post('/admin/mailer/api/templates/hi/publish')

  await request.post('/admin/mailer/api/flows', {
    data: { slug: 'hi', name: 'Hi', trigger: { eventName: 'Created', once: true } },
  })
  await request.patch('/admin/mailer/api/flows/hi/draft', {
    data: { steps: [{ type: 'send', templateSlug: 'hi' }] },
  })
  await request.post('/admin/mailer/api/flows/hi/publish')

  // Fire twice for the same contact + tick twice.
  await request.post('/__test__/fire', { data: { eventName: 'Created', externalId: 'bob' } })
  await request.post('/__test__/tick')
  await request.post('/__test__/fire', { data: { eventName: 'Created', externalId: 'bob' } })
  await request.post('/__test__/tick')

  // Only one run + one send.
  const runs = await (await request.get('/__test__/db/flowRuns')).json()
  const sends = await (await request.get('/__test__/db/sends')).json()
  expect(runs).toHaveLength(1)
  expect(sends).toHaveLength(1)
})
