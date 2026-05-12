/* Sample data — replaced by REST fetches against /admin/mailer/api/* once wired. */

export const sample = {
  flows: [
    { slug: 'welcome', name: 'Welcome series', trigger: 'event: Created', goal: 'activation', enabled: true, active: 142, sends7d: 412, version: 4 },
    { slug: 'activation-rescue', name: 'Activation rescue', trigger: 'event: Downloaded app', goal: 'activation', enabled: true, active: 23, sends7d: 87, version: 3 },
    { slug: 'pro-welcome', name: 'Pro welcome', trigger: 'event: Customer', goal: 'retention', enabled: true, active: 8, sends7d: 24, version: 1 },
    { slug: 'cancel-save', name: 'Cancel-save', trigger: 'event: Cancelled', goal: 'retention', enabled: true, active: 4, sends7d: 11, version: 2 },
    { slug: 'winback-30d', name: 'Win-back · 30 days', trigger: 'segment_enter', goal: 'reactivation', enabled: false, active: 0, sends7d: 0, version: 1 },
    { slug: 'free-limit-nudge', name: 'Free-limit nudge', trigger: 'event: Hit Free Limit', goal: 'conversion', enabled: true, active: 19, sends7d: 56, version: 2 },
    { slug: 'abandoned-storyboard', name: 'Abandoned storyboard', trigger: 'event: Viewed Storyboard', goal: 'activation', enabled: true, active: 38, sends7d: 142, version: 5 },
    { slug: 'password-reset', name: 'Password reset', trigger: 'event: PasswordResetRequested', goal: 'transactional', enabled: true, active: 0, sends7d: 91, version: 1 },
  ],

  templates: [
    { slug: 'welcome-1', name: 'Welcome · day 0', kind: 'marketing', lastSent: '12 min ago', sent7d: 412, openRate: 0.62, clickRate: 0.18 },
    { slug: 'welcome-2', name: 'Welcome · day 2', kind: 'marketing', lastSent: '1 h ago', sent7d: 318, openRate: 0.49, clickRate: 0.12 },
    { slug: 'activation-rescue-1', name: 'Try a starter storyboard', kind: 'marketing', lastSent: '23 min ago', sent7d: 87, openRate: 0.41, clickRate: 0.09 },
    { slug: 'pro-welcome', name: "You're on Pro 🎉", kind: 'marketing', lastSent: '3 h ago', sent7d: 24, openRate: 0.71, clickRate: 0.28 },
    { slug: 'receipt', name: 'Receipt', kind: 'transactional', lastSent: '2 min ago', sent7d: 1840, openRate: 0.55, clickRate: 0.04 },
    { slug: 'password-reset', name: 'Password reset', kind: 'transactional', lastSent: '8 min ago', sent7d: 91, openRate: 0.92, clickRate: 0.88 },
    { slug: 'free-limit-nudge', name: "You're close to your limit", kind: 'marketing', lastSent: '1 d ago', sent7d: 56, openRate: 0.38, clickRate: 0.07 },
    { slug: 'abandoned-storyboard-1', name: 'Pick up where you left off', kind: 'marketing', lastSent: '47 min ago', sent7d: 142, openRate: 0.44, clickRate: 0.11 },
  ],

  broadcasts: [
    { slug: 'product-update-may', name: 'Product update · May 2026', status: 'sent', scheduledAt: 'May 4, 2026', recipients: 11243, opens: 0.43, clicks: 0.09 },
    { slug: 'feature-import-beta', name: 'Import beta launching', status: 'scheduled', scheduledAt: 'May 14, 2026 · 10:00 PT', recipients: 4231, opens: null, clicks: null },
    { slug: 'year-in-review-2025', name: 'Year in review 2025', status: 'sent', scheduledAt: 'Jan 7, 2026', recipients: 9182, opens: 0.51, clicks: 0.21 },
    { slug: 'summer-launch', name: 'Summer launch teaser', status: 'draft', scheduledAt: null, recipients: null, opens: null, clicks: null },
    { slug: 'win-back-q1', name: 'Win-back · Q1 inactive', status: 'sent', scheduledAt: 'Mar 18, 2026', recipients: 2103, opens: 0.22, clicks: 0.04 },
  ],

  sends: [
    { id: 'snd_8a2f', template: 'welcome-1', to: 'ana@arcfound.io', status: 'delivered', time: '12s ago', flow: 'welcome', opens: 0, clicks: 0 },
    { id: 'snd_8a2e', template: 'receipt', to: 'jordan@parsley.app', status: 'delivered', time: '32s ago', flow: null, opens: 1, clicks: 0 },
    { id: 'snd_8a2d', template: 'welcome-1', to: 'kai+test@gmail.com', status: 'opened', time: '1m ago', flow: 'welcome', opens: 2, clicks: 0 },
    { id: 'snd_8a2c', template: 'abandoned-storyboard-1', to: 'mira@studio.tv', status: 'clicked', time: '1m ago', flow: 'abandoned-storyboard', opens: 1, clicks: 1 },
    { id: 'snd_8a2b', template: 'password-reset', to: 'lee@hello.com', status: 'delivered', time: '2m ago', flow: null, opens: 1, clicks: 1 },
    { id: 'snd_8a2a', template: 'free-limit-nudge', to: 'robin@bidshop.io', status: 'bounced', time: '2m ago', flow: 'free-limit-nudge', opens: 0, clicks: 0, bounce: 'hard' },
    { id: 'snd_8a29', template: 'activation-rescue-1', to: 'sasha@unfold.co', status: 'delivered', time: '3m ago', flow: 'activation-rescue', opens: 0, clicks: 0 },
    { id: 'snd_8a28', template: 'welcome-1', to: 'iris@northst.ar', status: 'suppressed', time: '4m ago', flow: 'welcome', opens: 0, clicks: 0 },
    { id: 'snd_8a27', template: 'welcome-2', to: 'amy@cinemastudio.com', status: 'opened', time: '5m ago', flow: 'welcome', opens: 1, clicks: 0 },
    { id: 'snd_8a26', template: 'receipt', to: 'team@floatdesign.co', status: 'delivered', time: '5m ago', flow: null, opens: 0, clicks: 0 },
    { id: 'snd_8a25', template: 'pro-welcome', to: 'n@orbit.tv', status: 'clicked', time: '7m ago', flow: 'pro-welcome', opens: 1, clicks: 2 },
    { id: 'snd_8a24', template: 'abandoned-storyboard-1', to: 'frank@cutscene.media', status: 'delivered', time: '7m ago', flow: 'abandoned-storyboard', opens: 0, clicks: 0 },
  ],

  contacts: [
    { id: 'u_2018f', email: 'ana@arcfound.io', name: 'Ana Vasquez', status: 'subscribed', tier: 'Pro', lastEvent: 'Exported · 2h ago', tags: ['pro', 'engaged'] },
    { id: 'u_2018e', email: 'jordan@parsley.app', name: 'Jordan Lee', status: 'subscribed', tier: 'Free', lastEvent: 'Uploaded · 4h ago', tags: ['beta'] },
    { id: 'u_2018d', email: 'kai+test@gmail.com', name: 'Kai Tobias', status: 'pending_doi', tier: 'Free', lastEvent: 'Created · 1d ago', tags: [] },
    { id: 'u_2018c', email: 'mira@studio.tv', name: 'Mira Okafor', status: 'subscribed', tier: 'Pro', lastEvent: 'Viewed Storyboard · 8m ago', tags: ['pro', 'vip'] },
    { id: 'u_2018b', email: 'lee@hello.com', name: 'Lee Wong', status: 'subscribed', tier: 'Free', lastEvent: 'Imported · 22m ago', tags: ['imported'] },
    { id: 'u_2018a', email: 'robin@bidshop.io', name: 'Robin Park', status: 'bounced', tier: 'Free', lastEvent: 'Hit Free Limit · 6h ago', tags: [] },
    { id: 'u_20189', email: 'sasha@unfold.co', name: 'Sasha Petrov', status: 'subscribed', tier: 'Pro', lastEvent: 'Downloaded app · 15m ago', tags: ['engaged'] },
    { id: 'u_20188', email: 'iris@northst.ar', name: 'Iris Chen', status: 'unsubscribed', tier: 'Free', lastEvent: 'Created · 9d ago', tags: [] },
  ],

  suppressions: [
    { email: 'robin@bidshop.io', scope: 'all', reason: 'hard_bounce', source: 'provider webhook', added: '12 min ago' },
    { email: 'iris@northst.ar', scope: 'marketing', reason: 'unsubscribed', source: 'one-click', added: '4 min ago' },
    { email: 'old-lead@example.com', scope: 'all', reason: 'complaint', source: 'provider webhook', added: '1 h ago' },
    { email: 'billing@deadco.io', scope: 'marketing', reason: 'manual', source: 'manual:jeff', added: '3 h ago' },
    { email: 'no-reply@noreply.com', scope: 'all', reason: 'list_cleaning', source: 'import:march-2026', added: '1 d ago' },
    { email: 'test@mailinator.com', scope: 'all', reason: 'gdpr_forget', source: 'manual:legal', added: '2 d ago' },
  ],

  audit: [
    { actor: 'human:jeff@jeffjassky.com', action: 'flow.publish', target: 'flows/activation-rescue', time: '4 min ago', note: 'v3 → published' },
    { actor: 'system:runner', action: 'broadcast.send.start', target: 'broadcasts/product-update-may', time: '12 min ago', note: '11,243 recipients' },
    { actor: 'human:jeff@jeffjassky.com', action: 'template.update', target: 'templates/welcome-1', time: '23 min ago', note: 'Subject + preheader' },
    { actor: 'system:webhook', action: 'suppression.add', target: 'suppressions/robin@bidshop.io', time: '1 h ago', note: 'hard_bounce' },
    { actor: 'human:taylor@team', action: 'broadcast.schedule', target: 'broadcasts/feature-import-beta', time: '2 h ago', note: 'scheduled May 14, 10:00 PT · count confirmed 4231' },
    { actor: 'human:jeff@jeffjassky.com', action: 'suppression.remove', target: 'suppressions/lee@hello.com', time: '3 h ago', note: 'manual override' },
    { actor: 'script:deploy', action: 'flow.update.draft', target: 'flows/abandoned-storyboard', time: '5 h ago', note: 'added step 4 (wait 1d)' },
    { actor: 'system:runner', action: 'health.trip', target: 'mailer_health', time: '8 h ago', note: 'hard bounce rate 2.4%' },
    { actor: 'human:jeff@jeffjassky.com', action: 'health.resume', target: 'mailer_health', time: '7 h ago', note: 'manual' },
  ],

  sendSeries: [12, 14, 9, 11, 18, 22, 31, 28, 24, 31, 38, 42, 39, 36, 41, 48, 52, 49, 44, 38, 32, 28, 22, 18],
  openSeries: [8, 9, 6, 7, 11, 14, 19, 18, 16, 21, 26, 28, 26, 24, 27, 32, 35, 33, 30, 26, 22, 19, 15, 12],
}
