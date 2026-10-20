# Contributing to TWS Panel

Thank you for considering a contribution! This project exists because hosting your own
infrastructure should not require a heavy panel or a monthly fee. Every bit of help to keep it
light, secure and simple is welcome.

Portuguese (Brazil) version: [docs/community/pt-BR/CONTRIBUTING.md](docs/community/pt-BR/CONTRIBUTING.md).

Before you start, read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

- **Questions and ideas:** use [GitHub Discussions](https://github.com/kelvindk9w/tws-panel/discussions)
  if they are enabled for the repository, or open an issue with the question template.
- **Bugs:** open an issue with the bug report form. Never include tokens, passwords or client
  domains in logs.
- **Security vulnerabilities:** never open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Documentation fixes** are as valuable as code. Typos, unclear steps and missing translations are
  great first contributions (see [Documentation](#documentation)).

## Local setup

Requirements: **Node >= 22**, **pnpm** (via `corepack enable`) and **Docker**.

```bash
git clone https://github.com/kelvindk9w/tws-panel.git && cd tws-panel
pnpm install
SETUP_TOKEN=dev-token pnpm dev
```

- API at `http://localhost:9000`, frontend with hot reload at `http://localhost:5173`
- Wizard: `http://localhost:5173/setup` (token `dev-token`)
- Useful commands: `pnpm build`, `pnpm typecheck`

More detail on the architecture and the dev mode is in the
[local development guide](site/src/content/docs/en/development/local-development.md).

## Local validation hooks (pre-commit / pre-push)

The repository versions git hooks in `scripts/hooks/` (plain bash, **no husky and no new
dependencies**). They are **activated automatically** by `pnpm install` (the root `prepare` script
points `core.hooksPath` to `scripts/hooks`), so there is nothing to do. Philosophy: the hooks give
fast feedback on your machine; **CI remains the final gate**.

- **`pre-commit`** (fast, target < 30s), runs only on what is staged:
  1. blocks forbidden files (`.env`, `data/`, `*.pem`, `id_rsa`, etc.);
  2. a light secrets scan of the staged files (`scripts/hooks/scan-secrets.mjs`: AWS keys,
     `PRIVATE KEY` blocks, Slack/GitHub tokens, passwords assigned in strings), reporting
     `file:line`;
  3. incremental typecheck (`tsc --noEmit`) only in the workspaces you touched.
- **`pre-push`** (complete): `pnpm test` + `pnpm test:coverage` (thresholds) + `pnpm build`. If any
  step fails, the push is aborted with a summary of the error.

**Emergencies:** `git commit --no-verify` skips the pre-commit and `PAAS_SKIP_PREPUSH=1 git push`
skips the pre-push. Use them sparingly, because **CI will catch** anything that gets through.

The secrets scanner is intentionally light so that it needs no system dependency. For a deeper scan
we recommend installing [gitleaks](https://github.com/gitleaks/gitleaks) locally (optional).

## Tests

The project uses **Vitest** for unit tests (packages, server and frontend) and its own E2E scripts
(`node:assert`) for the flows that depend on Docker.

```bash
pnpm test            # unit tests of every package + app (Vitest)
pnpm test:unit       # the same, explicitly
pnpm test:coverage   # unit tests with v8 coverage (thresholds per package)
pnpm test:e2e        # full E2E: test:fase4 + test:mail (REQUIRES Docker)
pnpm test:fase4      # phase 4 E2E only (guardrails + monitoring)
pnpm test:mail       # phase 3 E2E only (email)
```

Unit tests live in `tests/` inside each package/app (for example
`packages/deploy/tests/detect.test.ts`). Mandatory philosophy: **tests verify the RESULT of
actions** (correct state, correct data, findings generated), never just an HTTP 200. Each
guardrail rule or check needs: the case that triggers it, the case that does NOT trigger it and at
least one edge case. DNS resolvers, runners and Docker services are injectable precisely so that
mocks can be deterministic.

Coverage (`pnpm test:coverage`) focuses on pure logic. The engine/exec/runner code talks to Docker
and is covered by the E2E tests (the exact list of files outside the unit scope, with the reason,
is in the comment of each package/app `vitest.config.ts`). Coverage targets per package
(thresholds in `vitest.config.ts`; CI fails if they regress):

| Package/App         | Lines  | Branches | Functions |
| ------------------- | ------ | -------- | --------- |
| `packages/core`     | >= 98% | >= 98%   | >= 98%    |
| `packages/security` | >= 98% | >= 96%   | >= 98%    |
| `packages/mailer`   | >= 98% | >= 98%   | >= 98%    |
| `packages/deploy`   | >= 97% | >= 95%   | >= 97.5%  |
| `apps/server`       | >= 94% | >= 91%   | >= 98%    |

The known residuals (unreachable defensive branches, TOCTOU catches in disk scans, `system-info`
branches that depend on the host hardware) are documented in the configs themselves. When you add
new logic, keep the thresholds green.

**Convention: every PR needs tests** covering the change (unit for pure logic, component tests for
UI, E2E for infrastructure flows), and **green CI is mandatory**. The `.github/workflows/ci.yml`
workflow runs install, typecheck, build and unit tests with coverage (thresholds) on pushes and
PRs to the `main` and `dev` branches.

## Project standards

- **Strict TypeScript** across the monorepo (`pnpm typecheck` must pass). Code and identifiers in
  **English**; the panel UI and the explanatory code comments are in **Brazilian Portuguese**.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, in Portuguese
  or English, in the imperative (for example `feat: add guardrail rule X`).
- **Simple persistence**: state in JSON/SQLite under `data/` (mode 0600 when sensitive), and no new
  external services without prior discussion.
- **Security is not optional**: no arbitrary shell coming from the UI, no secrets in logs, no ports
  exposed by default. Sensitive actions must produce an audit record.
- Make **minimal, focused changes**. Do not reformat files you are not changing.

## Documentation

The guides are Markdown files in `site/src/content/docs/<language>/`, published as a website with
[Starlight](https://starlight.astro.build/). **English (`en`) is the main language**; Portuguese
(`pt-br`) is secondary, and the structure accepts more languages.

- A file has the **same relative path in every language**. A page that is not translated yet is
  shown in English on the site, so a translation can be added one page at a time.
- Link between guides with relative `.md` paths (`../guides/operations.md#anchor`). They work on
  GitHub and are rewritten for the website at build time.
- Keep commands, flags and paths identical across languages; translate the explanation around them.
  The panel UI is currently Portuguese only, so keep screen labels exactly as they appear in the UI
  and add a translation in parentheses.
- Use `example.com` and `203.0.113.x` (documentation range) in examples. Never use real domains,
  IPs, tokens or bucket endpoints.
- Preview and check your changes:

```bash
pnpm docs:dev     # local preview with live reload
pnpm docs:build   # same build the GitHub Pages workflow runs
pnpm docs:links   # checks internal links and anchors in every .md file
```

To add a language, copy the `en` folder to a new folder named after the locale, translate what you
can, and add the locale to `site/astro.config.mjs`.

## How to extend the panel

### Add a security check

Checks live in `packages/security/src/checks.ts`. Each check declares an id, a severity, how to
detect the problem (read-only) and, when applicable, how to fix it (idempotent). System fix scripts
live in `scripts/hardening/` (see `lib.sh` for the idempotency and backup helpers). See
`docs/internal/security-research.md` (in Portuguese): it is the spec that guides what is worth
checking and why.

### Add a guardrail rule

Rules live in `packages/deploy/src/rules.ts`. Each rule receives the project source (compose, env,
files) and returns findings with a **level** (`block` | `warn` | `info`), **evidence**
(file:service or file:line) and a **fix suggestion**. Prefer conservative regexes (a false positive
at `block` is the worst case). Cover the rule with unit tests in `packages/deploy/tests/` (the case
that triggers it, the case that does not, and an edge case) and validate the full flow with
`pnpm test:fase4`.

### Add a deploy pipeline

Detection lives in `packages/deploy/src/detect.ts` and execution in
`packages/deploy/src/engine.ts`. A new pipeline must: (1) be detectable from the project files,
(2) build and start containers **on the `paas-net` network**, and (3) go through the guardrails like
any other deploy. Use the examples in `examples/` as a reference.

## Pull request flow

1. Open an **issue** before large changes (or comment on an existing one) to agree on the design,
   which avoids rework.
2. Fork, and create a branch from `dev` (`feat/my-improvement`).
3. Make sure `pnpm build` and `pnpm typecheck` are clean and **`pnpm test` is green** (plus
   `pnpm test:e2e` if the change touches infrastructure flows). Every PR must include tests for the
   change; CI blocks the merge without them.
4. Open the PR filling in the template: what changes, why, how to test.
5. Respond to the review. Small, focused PRs are accepted much faster.

## License of your contribution

TWS Panel is distributed under the [MIT](LICENSE) license, and it remains so: this project is and
will remain open source.

By opening a Pull Request, you declare that:

1. **The contribution is yours**, or you have the right to submit it. If it contains third-party
   code, you identify the origin and the license in the PR itself.
2. **You grant TWS** a perpetual, worldwide, irrevocable, royalty-free license to use, reproduce,
   modify, distribute and **sublicense** your contribution, including under terms different from
   the current ones.
3. **You keep authorship and the right to use your contribution** however you like, anywhere else.
   Nothing here takes anything away from you.

> [!NOTE]
> **Why this exists, plainly.** Item 2 allows TWS to offer the panel under other conditions in the
> future, for example a managed or paid edition that funds development. Without that permission,
> any change in that direction would require locating and getting the agreement of every person who
> has ever contributed; it would take a single person who cannot be found to make it impossible.
>
> **What this does NOT mean:** code already published under MIT stays MIT forever. That is
> irreversible by the nature of the license, and nobody can take away from you what is already
> there. This repository remains open and free. If you do not agree with item 2, say so in the PR:
> we can talk about another arrangement, or you can simply keep your contribution as a fork.

There is no form to sign: opening the PR already counts as acceptance.

## Reporting bugs and suggesting features

Use the issue forms on GitHub. For **security vulnerabilities**, never open a public issue; follow
[SECURITY.md](SECURITY.md).
