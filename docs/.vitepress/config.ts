import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'mailery',
  description:
    'Embedded email automation for Node.js + MongoDB. Triggered flows, broadcasts, tracking, and an admin UI you mount inside your Express app.',
  base: '/mailery/',
  lastUpdated: true,
  cleanUrls: true,
  markdown: {
    // MJML is XML-shaped; alias it to HTML so Shiki highlights it correctly.
    languageAlias: {
      mjml: 'html',
    },
    // Wrap inline code in `v-pre` so Handlebars `{{ }}` inside backticks
    // isn't parsed as Vue interpolation. Fenced code blocks get v-pre by
    // VitePress already; this fills in the inline-code gap.
    config: (md) => {
      const defaultInline = md.renderer.rules.code_inline
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const rendered = defaultInline
          ? defaultInline(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options)
        return rendered.replace(/^<code/, '<code v-pre')
      }
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/mailery/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#f97316' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'mailery — embedded email automation' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Triggered flows, broadcasts, tracking, suppression, and a React admin UI for Node + MongoDB apps.',
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/mailer' },
      { text: 'GitHub', link: 'https://github.com/JeffJassky/mailery' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Using mailery',
          items: [
            { text: 'Events', link: '/guide/events' },
            { text: 'Flows', link: '/guide/flows' },
            { text: 'Templates', link: '/guide/templates' },
            { text: 'Broadcasts', link: '/guide/broadcasts' },
            { text: 'Suppression & unsubscribe', link: '/guide/suppression' },
            { text: 'Tracking', link: '/guide/tracking' },
          ],
        },
        {
          text: 'Operating',
          items: [
            { text: 'Providers', link: '/guide/providers' },
            { text: 'Queue drivers', link: '/guide/queues' },
            { text: 'Deliverability', link: '/guide/deliverability' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Admin UI', link: '/guide/admin-ui' },
            { text: 'Testing', link: '/guide/testing' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API',
          items: [
            { text: 'Mailer', link: '/reference/mailer' },
            { text: 'MongoContactAdapter', link: '/reference/mongo-contact-adapter' },
            { text: 'Providers', link: '/reference/providers' },
            { text: 'Routers', link: '/reference/routers' },
            { text: 'Template utilities', link: '/reference/templates' },
            { text: 'Testing helpers', link: '/reference/testing' },
          ],
        },
        {
          text: 'Types & schemas',
          items: [
            { text: 'Contact & adapter', link: '/reference/types-contact' },
            { text: 'Flow steps & predicates', link: '/reference/types-flow' },
            { text: 'Segments', link: '/reference/types-segment' },
            { text: 'MailProvider', link: '/reference/types-provider' },
          ],
        },
        {
          text: 'HTTP',
          items: [
            { text: 'Public endpoints', link: '/reference/public-endpoints' },
            { text: 'Admin REST API', link: '/reference/admin-api' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/JeffJassky/mailery' },
    ],
    editLink: {
      pattern: 'https://github.com/JeffJassky/mailery/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jeff Jassky',
    },
    search: { provider: 'local' },
  },
})
