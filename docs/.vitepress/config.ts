import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'mailery',
  description:
    'Embedded, MongoDB-backed email automation for Node.js. Triggered flows, broadcasts, tracking, and an admin UI you mount inside your Express app.',
  // GitHub Pages project site path. If you later attach a custom domain
  // (e.g. mailery.dev) via CNAME, change this to '/'.
  base: '/mailery/',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', href: '/mailery/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Design', link: '/design/' },
      { text: 'GitHub', link: 'https://github.com/JeffJassky/mailery' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
      ],
      '/design/': [
        {
          text: 'Design',
          items: [
            { text: 'Overview', link: '/design/' },
            { text: 'Vision', link: '/design/vision' },
            { text: 'Architecture', link: '/design/architecture' },
            { text: 'Data model', link: '/design/data-model' },
            { text: 'Roadmap', link: '/design/roadmap' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/JeffJassky/mailery' },
    ],
    editLink: {
      pattern:
        'https://github.com/JeffJassky/mailery/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jeff Jassky',
    },
    search: {
      provider: 'local',
    },
  },
})
