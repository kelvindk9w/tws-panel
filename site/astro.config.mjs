// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkDocLinks from './plugins/remark-doc-links.mjs';
import remarkGithubAlerts from './plugins/remark-github-alerts.mjs';

// GitHub Pages project site: https://kelvindk9w.github.io/tws-panel/
const base = '/tws-panel';
const repo = 'https://github.com/kelvindk9w/tws-panel';

// Sidebar entries use the same slugs in every language. A page that exists
// only in English is served in English under /pt-br/ with a notice (Starlight
// fallback), so adding a new language is a matter of adding a folder under
// src/content/docs/ and one entry in `locales` below.
export default defineConfig({
  site: 'https://kelvindk9w.github.io',
  base,
  trailingSlash: 'always',
  markdown: {
    remarkPlugins: [[remarkDocLinks, { base }], remarkGithubAlerts],
  },
  integrations: [
    starlight({
      title: 'TWS Panel',
      description:
        'Self-hosted PaaS panel for your own Ubuntu VPS: hardening, HTTPS deploys, email and backups.',
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        'pt-br': { label: 'Português (Brasil)', lang: 'pt-BR' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting started',
          translations: { 'pt-BR': 'Primeiros passos' },
          items: [
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/security-wizard' },
            { slug: 'getting-started/complete-guide' },
          ],
        },
        {
          label: 'Guides',
          translations: { 'pt-BR': 'Guias' },
          items: [
            { slug: 'guides/features' },
            { slug: 'guides/operations' },
            { slug: 'guides/production' },
            { slug: 'guides/restore-new-server' },
            { slug: 'guides/troubleshooting' },
            { slug: 'guides/recover-access' },
            { slug: 'guides/network-migration' },
          ],
        },
        {
          label: 'Reference',
          translations: { 'pt-BR': 'Referência' },
          items: [{ slug: 'reference/security' }, { slug: 'reference/host-bridge' }],
        },
        {
          label: 'Development',
          translations: { 'pt-BR': 'Desenvolvimento' },
          items: [{ slug: 'development/local-development' }],
        },
      ],
    }),
  ],
});
