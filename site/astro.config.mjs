// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
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
      // llms.txt, llms-full.txt and llms-small.txt at the site root, for AI assistants. The plugin reads
      // only the default locale (English); the pages are the same in Portuguese under /pt-br/.
      plugins: [
        starlightLlmsTxt({
          details: [
            'TWS Panel is an open-source panel (MIT) installed on your own Ubuntu VPS. It hardens the server,',
            'deploys Git repositories with Docker Compose behind a central Caddy with automatic HTTPS, runs its',
            'own mail server (Stalwart) with webmail, takes backups and tests the restore in a throwaway copy, and',
            'checks every compose file against guardrails before a deploy. The interface is in English and',
            'Brazilian Portuguese; some server messages (deploy log, guardrail cards) are still in Portuguese.',
            '',
            'Preparing another project to be published on the panel? Start with "Prepare your project",',
            '"Instructions for your AI agent" and "Compose rules", also available as the set below.',
          ].join('\n'),
          promote: ['en/index*', 'en/getting-started/installation', 'en/guides/features', 'en/guides/prepare-project'],
          demote: ['en/development/**', '404'],
          exclude: ['404'],
          customSets: [
            {
              label: 'Preparing a project for the panel',
              description: 'what a repository and its compose file need to deploy on the panel, for AI agents',
              paths: [
                'en/guides/prepare-project',
                'en/guides/agent-prompt',
                'en/guides/compose-rules',
                'en/guides/nextjs',
                'en/guides/database',
              ],
            },
          ],
          optionalLinks: [{ label: 'Source code', url: repo, description: 'the GitHub repository' }],
        }),
      ],
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
            { slug: 'guides/agent-prompt' },
            { slug: 'guides/nextjs' },
            { slug: 'guides/saas-domains' },
            { slug: 'guides/database' },
            { slug: 'guides/operations' },
            { slug: 'guides/production' },
            { slug: 'guides/troubleshooting' },
            { slug: 'guides/email-deliverability' },
            { slug: 'guides/email-troubleshooting' },
            { slug: 'guides/server-logs' },
            { slug: 'guides/compose-rules' },
            { slug: 'guides/recover-access' },
            { slug: 'guides/ai-access' },
            { slug: 'guides/mcp' },
            { slug: 'guides/network-migration' },
            { slug: 'guides/real-visitor-ip' },
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
