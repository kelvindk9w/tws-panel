# Contributing to TWS Panel

Thank you for considering a contribution! This project exists because hosting your own
infrastructure should not require a heavy panel or a monthly fee. Any help in keeping it light,
secure and simple is welcome.

Portuguese (Brazil) version: [docs/community/pt-BR/CONTRIBUTING.md](docs/community/pt-BR/CONTRIBUTING.md).

Before you start, please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

- **Questions and ideas:** use [GitHub Discussions](https://github.com/kelvindk9w/tws-panel/discussions),
  or open an issue with the question form.
- **Bugs:** open an issue with the bug report form. Remove tokens, passwords and client domains from
  any logs you attach.
- **Security vulnerabilities:** never open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Documentation fixes** are as valuable as code. Typos, unclear steps and missing translations
  make great first contributions (see [Documentation](#documentation)).

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

The repository ships git hooks in `scripts/hooks/` (plain bash, **no husky and no new
dependencies**). They are **activated automatically** by `pnpm install` (the root `prepare` script
points `core.hooksPath` to `scripts/hooks`), so there is nothing to set up. The hooks give you fast
feedback on your machine; **CI remains the final gate**.

- **`pre-commit`** (fast, under 30 s) runs only on staged files:
  1. blocks forbidden files (`.env`, `data/`, `*.pem`, `id_rsa`, etc.);
  2. a lightweight secret scan of the staged files (`scripts/hooks/scan-secrets.mjs`: AWS keys,
     `PRIVATE KEY` blocks, Slack/GitHub tokens, passwords assigned in strings), reporting
     `file:line`;
  3. incremental typecheck (`tsc --noEmit`) only in the workspaces you touched.
- **`pre-push`** (complete): `pnpm test` + `pnpm test:coverage` (thresholds) + `pnpm build`. If any
  step fails, the push is aborted with a summary of the error.

**Emergencies:** `git commit --no-verify` skips the pre-commit and `PAAS_SKIP_PREPUSH=1 git push`
skips the pre-push. Use them sparingly: **CI will catch** anything that gets through.

The secrets scanner is intentionally light so that it needs no system dependency. For a deeper scan,
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
`packages/deploy/tests/detect.test.ts`). The core principle: **tests verify the RESULT of an
action** (the correct state, the correct data, the findings generated), never just an HTTP 200.
Each guardrail rule or check needs a case that triggers it, a case that does NOT trigger it and at
least one edge case. DNS resolvers, runners and Docker services are injectable so that mocks stay
deterministic.

Coverage (`pnpm test:coverage`) focuses on pure logic. The engine, exec and runner code talks to
Docker and is covered by the E2E tests; the exact list of files outside the unit scope, with the
reason, is in the comments of each package's or app's `vitest.config.ts`. The coverage thresholds
per package are set in `vitest.config.ts`, and CI fails if they regress:

| Package/App         | Lines  | Branches | Functions |
| ------------------- | ------ | -------- | --------- |
| `packages/core`     | >= 98% | >= 98%   | >= 98%    |
| `packages/security` | >= 98% | >= 96%   | >= 98%    |
| `packages/mailer`   | >= 98% | >= 98%   | >= 98%    |
| `packages/deploy`   | >= 97% | >= 95%   | >= 97.5%  |
| `apps/server`       | >= 94% | >= 91%   | >= 98%    |

The known residual gaps (unreachable defensive branches, TOCTOU catches in disk scans, `system-info`
branches that depend on the host hardware) are documented in the configs themselves. When you add
new logic, keep the thresholds green.

**Every PR needs tests** that cover the change (unit tests for pure logic, component tests for UI,
E2E for infrastructure flows), and **CI must be green**. The `.github/workflows/ci.yml` workflow
runs install, typecheck, build and unit tests with coverage thresholds on pushes and pull requests
to the `main` and `dev` branches. It also runs an `image-scan` job (Trivy) that fails the PR when
the panel image has a CRITICAL vulnerability with a fix available.

## Project standards

- **Strict TypeScript** across the monorepo (`pnpm typecheck` must pass). Code and identifiers are
  in **English**; the panel UI and the explanatory code comments are in **Brazilian Portuguese**.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, written in
  Portuguese or English, in the imperative mood (for example `feat: add guardrail rule X`).
- **Simple persistence**: state is kept in JSON files under `data/` (mode 0600 when sensitive).
  Do not add new external services without discussing it first.
- **Security is not optional**: no arbitrary shell commands built from user input (the web terminal
  is the one deliberate exception), no secrets in logs, no ports exposed by default. Sensitive
  actions must produce an audit record.
- Keep changes **minimal and focused**. Do not reformat files you are not otherwise changing.

## Documentation

The guides are Markdown files in `site/src/content/docs/<language>/`, published as a website with
[Starlight](https://starlight.astro.build/). **English (`en`) is the main language**; Portuguese
(`pt-br`) is secondary, and the structure accepts more languages.

- A page has the **same relative path in every language**. A page that is not translated yet is
  shown in English on the site, so translations can be added one page at a time.
- Link between guides with relative `.md` paths (`../guides/operations.md#anchor`). They work on
  GitHub and are rewritten for the website at build time.
- Keep commands, flags and paths identical across languages, and translate only the text around
  them. The panel UI exists in English and Portuguese, so quote each screen label exactly as it
  appears in the language of the page (see `site/README.md`).
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
live in `scripts/hardening/` (see `lib.sh` for the idempotency and backup helpers). The spec in
`docs/internal/security-research.md` (in Portuguese) explains what is worth checking and why.

### Add a guardrail rule

Rules live in `packages/deploy/src/rules.ts`. Each rule receives the project source (compose, env,
files) and returns findings with a **level** (`block` | `warn` | `info`), **evidence**
(file:service or file:line) and a **fix suggestion**. Prefer conservative regexes: a false positive
at `block` level is the worst outcome. Cover the rule with unit tests in `packages/deploy/tests/`
(a case that triggers it, a case that does not, and an edge case) and validate the full flow with
`pnpm test:fase4`.

### Add a deploy pipeline

Detection lives in `packages/deploy/src/detect.ts` and execution in
`packages/deploy/src/engine.ts`. A new pipeline must: (1) be detectable from the project files,
(2) build and start containers **on the `paas-net` network**, and (3) go through the guardrails like
any other deploy. Use the examples in `examples/` as a reference.

## Pull request flow

1. Open an **issue** before a large change (or comment on an existing one) to agree on the design
   first. This avoids rework.
2. Fork the repository and create a branch from `dev` (for example `feat/my-improvement`). `dev`
   is where work is integrated; `main` only receives validated code.
3. Make sure `pnpm build` and `pnpm typecheck` are clean and **`pnpm test` is green** (plus
   `pnpm test:e2e` if the change touches infrastructure flows). Every PR must include tests for its
   change.
4. Open the PR **against `dev`** (not the default `main`) and fill in the template: what changes, why, and how to test it.
5. Respond to the review. Small, focused PRs are merged much faster.
6. Before opening the PR, run `node scripts/check-no-real-hosts.mjs`. It rejects real IPs, domains and
   VPS hostnames, and it **warns** about new images (png/jpg/gif/webp): look at the picture yourself
   (no IP, hostname, domain or customer name), then add its hash to `scripts/imagens-revisadas.txt`
   (`node scripts/check-no-real-hosts.mjs --hash-imagens` prints the missing lines). Names that must never
   appear (customers, personal domains) are **not** listed in the repository: the maintainer keeps them as
   regular expressions in the Actions secret `CHECK_REAL_HOSTS_PATTERNS`
   (Settings → Secrets and variables → Actions → New repository secret). Save the value on a **single line**, with
   the patterns separated by `;;` (one per line also works locally). Write them without `\b` so they also
   catch the name glued inside other words. The CI passes the secret only to the `check-no-real-hosts` step,
   on pushes to `main`/`dev` and on PRs from the repository itself; PRs from forks do not
   receive secrets, so they run without it (and do not fail because of that). Locally, put the same lines
   in `.check-real-hosts.local` (ignored by Git; `#` starts a comment) or export the variable. The output
   only says the number of the pattern and the place, never the value.
7. The `commit-authors` job rejects new commits whose author or `Co-authored-by` is "Teste"
   (the identity of a test environment). When maintainers merge `dev` into `main` by squash, **delete any
   `Co-authored-by: Teste` line from the squash message** before confirming; the same job runs on the
   push to `main`/`dev` and shows it if it slipped through.

## License of your contribution

TWS Panel is distributed under the [MIT](LICENSE) license. This project is open source and
will remain so.

By opening a pull request, you declare that:

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
> any change in that direction would require finding every person who has ever contributed and
> getting their agreement, and a single contributor who cannot be found would be enough to block it.
>
> **What this does NOT mean:** code already published under MIT stays MIT forever. That is
> irreversible by the nature of the license, and nobody can take away from you what is already
> there. This repository remains open and free. If you do not agree with item 2, say so in the PR:
> we can talk about another arrangement, or you can simply keep your contribution as a fork.

There is no form to sign: opening the PR counts as acceptance.

## Reporting bugs and suggesting features

Use the issue forms on GitHub. For **security vulnerabilities**, never open a public issue; follow
[SECURITY.md](SECURITY.md).
