---
title: "Development and architecture"
---

How to run the panel on your computer and how the code is organized. To contribute (standards,
tests, pull request flow), read [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).

## Local dev mode

```bash
pnpm install
SETUP_TOKEN=dev-token pnpm dev
# or, with Docker:
SETUP_TOKEN=dev-token docker compose -f docker-compose.dev.yml up
```

- Panel (production build served by the API): `http://localhost:9000`
- Frontend with hot reload: `http://localhost:5173` (proxy `/api` → 9000)
- Wizard: `http://localhost:5173/setup` with the token `dev-token`
- Project domains: use `*.localhost` (served over plain HTTP by Caddy, no SSL)

> [!NOTE]
> The panel refuses writes (`POST`, `PUT`, `PATCH`, `DELETE`) that the browser flags as coming from
> another site. In dev at `http://localhost:5173` the Vite proxy changes the `Host` to `localhost:9000`,
> but the browser reports `Sec-Fetch-Site: same-origin`, and that is what counts — login works without
> any configuration. If some proxy in between strips that header and you get `403 forbidden_origin`,
> allow the page's origin: `ALLOWED_ORIGINS=http://localhost:5173 SETUP_TOKEN=dev-token pnpm dev`.
> When the wizard finishes, the setup token is deleted and stops being valid; to reopen the wizard use
> `./scripts/reset-setup.sh` (generates a new token).

Ready-to-deploy examples in [`examples/`](https://github.com/kelvindk9w/tws-panel/blob/main/examples/README.md).

> [!WARNING]
> The examples are **for testing only** — do not use them as a production base without review.

> [!IMPORTANT]
> 🔒 **Automatic validation:** `pnpm install` enables local pre-commit hooks
> (forbidden files + secret scan + incremental typecheck) and pre-push
> (tests + coverage + build). CI on GitHub Actions is the final gate —
> details in [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).

## Architecture

pnpm monorepo with strict TypeScript end to end:

```
tws-panel/
├── apps/
│   ├── server/                  # Fastify API: wizard, projects, domains, email,
│   │                            # certificates, notifications, backups,
│   │                            # security, alerts and auditing
│   └── web/                     # React SPA (Vite + Tailwind + shadcn/ui):
│                                # /setup wizard + dark pt-BR dashboard
├── packages/
│   ├── core/                    # shared types and constants
│   ├── security/                # scan engine + hardening + baseline/diff
│   ├── deploy/                  # detection, ingestion, guardrails, Caddy, pipelines
│   └── mailer/                  # Stalwart, DKIM, DNS checklist, blacklist,
│                                # deliverability score
├── scripts/
│   ├── install.sh               # one-shot installer (idempotent, 100% Docker)
│   ├── hardening/               # idempotent shell scripts per phase (00–07)
│   ├── hooks/                   # local git hooks (pre-commit / pre-push)
│   ├── show-token.sh, reset-*.sh, reativar-acesso-ip.sh,
│   │   restaurar-painel.sh, uninstall.sh  # VPS operations utilities
│   └── test-*.mts               # verification suites (Phases 3 and 4)
├── examples/                    # example apps for deploy (testing only)
├── site/                        # documentation site (Starlight); the guides live in site/src/content/docs/
├── docs/                        # README images, internal specs and the Portuguese community texts
├── comoFuncionaSistema/         # machine-readable documentation (for AI agents)
├── Dockerfile                   # multi-stage build of the panel (production)
├── docker-compose.yml           # production: panel on 127.0.0.1:PAAS_PORT (default 9000)
└── docker-compose.dev.yml       # local dev with hot reload
```

How the modules relate to each other:

```
                    ┌─────────────┐
        browser ───►│  apps/web   │ (SPA: wizard + dashboard)
                    └──────┬──────┘
                           │ /api
                    ┌──────▼──────┐      ┌───────────────┐
                    │ apps/server │─────►│ @paas/security│──► host (Lynis, UFW,
                    │  (Fastify)  │      └───────────────┘    fail2ban, baseline)
                    └──┬───┬───┬──┘
                       │   │   │      ┌───────────────┐
                       │   │   └─────►│  @paas/deploy │──► Docker + central Caddy
                       │   │          └───────────────┘    (automatic SSL)
                       │   │          ┌───────────────┐
                       │   └─────────►│ @paas/mailer  │──► Stalwart (SMTP/IMAP/DKIM)
                       │              └───────────────┘    + Roundcube (webmail)
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (shared types)
                                      └───────────────┘
        State persisted in the paas_data volume (/data, JSON files, mode 0600)
        — no database. External services only the ones you turn on: GitHub,
        Telegram and the S3/R2 storage for backups.
```

## Documentation site

The guides live in `site/src/content/docs/<language>/` (`en` is the default, `pt-br` the secondary
one) and are published with Starlight. Files have the same path in every language; a page that has
not been translated yet is shown in English on the site. To add a language, create its folder next
to `en/` and add an entry to `locales` in `site/astro.config.mjs`.

```bash
pnpm docs:dev     # local server with live reload
pnpm docs:build   # builds site/dist (the same step the GitHub Pages workflow runs)
pnpm docs:links   # checks internal links and anchors in every .md file
```

Between guides, use relative links to the `.md` file (for example `../guides/operations.md#anchor`):
they work on GitHub and are rewritten to the site URLs at build time.
