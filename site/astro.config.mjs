// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkDocLinks from './plugins/remark-doc-links.mjs';
import remarkGithubAlerts from './plugins/remark-github-alerts.mjs';

// GitHub Pages project site: https://kelvindk9w.github.io/tws-panel/
const base = '/tws-panel';
const repo = 'https://github.com/kelvindk9w/tws-panel';

// The first group is the step-by-step guide, in two chained parts (Part 1 Install, Part 2 Configure).
// The second group has the security wizard and the restore on a new VPS. Each page appears once.
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
      components: { Footer: './src/components/Footer.astro' },
      sidebar: [
        {
          label: 'Step-by-step guide',
          translations: { 'pt-BR': 'Guia passo a passo' },
          items: [{ slug: 'getting-started/installation' }, { slug: 'getting-started/complete-guide' }],
        },
        {
          label: 'Getting started',
          translations: { 'pt-BR': 'Primeiros passos' },
          items: [
            { slug: 'getting-started/security-wizard' },
            { slug: 'guides/restore-new-server' },
          ],
        },
        {
          label: 'Guides',
          translations: { 'pt-BR': 'Guias' },
          items: [
            { slug: 'guides/features' },
            { slug: 'guides/prepare-project' },
            { slug: 'guides/operations' },
            { slug: 'guides/production' },
            { slug: 'guides/troubleshooting' },
            { slug: 'guides/email-deliverability' },
            { slug: 'guides/compose-rules' },
            { slug: 'guides/recover-access' },
            { slug: 'guides/ai-access' },
            { slug: 'guides/network-migration' },
            { slug: 'guides/help' },
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
          items: [{ slug: 'development/local-development' }, { slug: 'development/translating-the-interface' }],
        },
      ],
    }),
  ],
});
