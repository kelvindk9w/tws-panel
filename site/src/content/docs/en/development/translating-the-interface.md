---
title: "Translating the interface"
---

The panel interface is available in English and Brazilian Portuguese (`pt-BR`, the source language). Adding another language
needs **only new files**: no component changes.

> [!NOTE]
> This covers the web interface (`apps/web`). Messages that the server itself returns (API errors, audit entries, health checks)
> are still written in Portuguese and shown as they come; they are tracked for a later phase. Docs live in `site/` and
> have their own language folders.

## How it works

- Texts live in `apps/web/src/locales/<language>/<area>.ts`, one flat object per area (`common`, `projects`, `mail`, `backups`...).
- A text is read by its key, `area.key`, for example `t("projects.list.empty")`.
- `{name}` inserts a value. Plurals use the suffixes `_one` / `_other` (and `_zero`, `_few`, `_many` when the language needs them) and a `count` value.
- `<b>...</b>`-style tags mark bold text, code and links in a few long texts. Keep the same tags and the same `{variables}` as the source text.
- A missing key falls back to `pt-BR` (never shows a raw key to the user).
- The language is chosen on the first visit from the browser (`pt*` becomes `pt-BR`, anything else becomes English) and then by the language selector in the user menu, on the sign-in page and under Settings → Appearance. The choice is kept in the browser (`localStorage`, key `paas.locale`).
- Dates, times, numbers and sorting use the language through `Intl`. The configured time zone is never changed by the language.

## Add a language (for example, Spanish)

1. Copy the folder `apps/web/src/locales/en/` to `apps/web/src/locales/es/` (the folder name is the language code).
2. Translate the values in every file. Do not rename keys. Keep `{variables}` and tags as they are. Follow `apps/web/src/locales/GLOSSARY.md` so the same concept always has the same word.
3. In `common.ts`, set `"language.name"` to the language written in itself (for example `"Español"`): this is what the selector shows.
4. Run the checks from `apps/web`:

   ```bash
   pnpm test -- tests/i18n-parity.test.ts   # same keys, variables and tags as pt-BR
   pnpm test:coverage                       # whole suite
   pnpm typecheck && pnpm build
   ```

5. Open the panel, pick the language in the selector and click through the main pages. No raw key such as `projects.list.empty` should appear.
6. Open a pull request. See [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).

The new language is picked up automatically: the selector, the browser detection (`es-MX` becomes `es`) and the fallback all read the folders in `locales/`.

## Change or add a text

Edit the `pt-BR` and `en` files together. A test fails if a key exists in only one of them, if the variables differ, or if a component brings back fixed Portuguese text instead of using a key.
