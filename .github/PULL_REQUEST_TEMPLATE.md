## What changes

<!-- A short, objective summary of the changes. -->

## Why

<!-- Motivation / related issue. Fixes #___ -->

## How to test

<!-- Steps to verify it works: commands, scenarios, screenshots. -->

## Checklist

- [ ] `pnpm build` passes across the monorepo
- [ ] `pnpm typecheck` passes
- [ ] Tests cover the change, and `pnpm test:coverage` passes (plus `pnpm test:mail` / `pnpm test:fase4` when it touches infrastructure flows)
- [ ] Commits follow the conventional style (`feat:`, `fix:`, `docs:`...)
- [ ] No secret or credential added to the code
- [ ] Docs updated (`site/src/content/docs/`, README) when applicable; `pnpm docs:links` passes
- [ ] Sensitive actions generate an audit record, when applicable
- [ ] I have read [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/dev/CONTRIBUTING.md), including the license terms for contributions
