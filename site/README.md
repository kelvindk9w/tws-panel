# Documentation site

The TWS Panel guides, built with [Starlight](https://starlight.astro.build) and published to
GitHub Pages. This folder is not part of the panel image.

```bash
pnpm docs:dev     # local server with live reload (from the repository root)
pnpm docs:build   # builds site/dist
pnpm --filter site check:build   # fails on raw [!NOTE] alerts or missing asides in the built HTML
pnpm docs:links   # checks relative links and anchors in every .md file of the repository
```

## Layout

```
site/
├── astro.config.mjs            # locales, sidebar, edit link
├── plugins/                    # remark: relative .md links and GitHub alerts (> [!NOTE])
├── scripts/check-build.mjs
└── src/content/docs/
    ├── 404.md                  # one bilingual 404 page (GitHub Pages serves a single 404.html)
    ├── en/                     # default language
    └── pt-br/                  # original text, written in Portuguese
```

`en/` and `pt-br/` have the same files and the same headings, anchors, commands, paths, variables,
URLs and numbers. Only the prose, the code comments, the placeholders and the interface labels
(quoted in the language of the page, see below) are translated.

## Adding a language

1. Copy `src/content/docs/en/` to `src/content/docs/<code>/` (for example `es`) and translate it.
   A page that is missing is shown in English, with a notice. Quote the interface labels from the
   panel dictionary of that language (`apps/web/src/locales/<code>/`, see
   [Translating the interface](src/content/docs/en/development/translating-the-interface.md));
   until the panel has that language, quote the English labels.
2. Add one entry to `locales` in `astro.config.mjs`, for example `es: { label: 'Español', lang: 'es' }`.
3. Add the translated section labels in `sidebar`. The key of `translations` is the `lang` value of
   the locale, not the locale key: for `pt-br` it is `'pt-BR'`, so for the example it is
   `translations: { es: '…' }` because `lang` is `'es'`. In `src/pages/index.astro`, add the
   language check that redirects the site root.
4. Add a block for the language in `src/content/docs/404.md` (a `<div data-lang-block="<code>">`)
   and the matching entry in the script at the end of that file. GitHub Pages serves a single
   404 page, and the script chooses the block from the first folder of the address.

Sidebar entries use slugs, so they are the same in every language.

## Navigation for newcomers

Three paths are kept visible, in this order, on the home page (`index.md`, hero buttons and the
"Where to start" table), in the first group of the sidebar and at the top of both READMEs:

1. **First installation**: the complete guide (`getting-started/complete-guide`). It is the main
   path and sends the reader to the installation guide for the details of Step 2.
2. **Reinstalled the VPS or moving servers**: `guides/restore-new-server`. It sits in the first
   sidebar group even though its file lives in `guides/`.
3. **Quick install, one command**: the "Installation" section of the README (it exists only there).

The "Getting started" sidebar group starts with the complete guide. The SSH warning ("REMOTE HOST
IDENTIFICATION HAS CHANGED") is one alert with the same text in the complete guide, the
installation guide, the restore guide and the README; the detailed explanation stays in the
collapsed block `#host-identification-changed` of the installation guide. If you change the text in
one place, change it in all of them, in both languages. The home page is plain Markdown on purpose: the project does not include `@astrojs/mdx`, so a Starlight
component (`Card`, `LinkCard`) written in an `.md` or `.mdx` file shows up as text. The language selector comes from Starlight
(header) and needs no configuration beyond `locales`.

## Editorial rules

- **Write in the imperative, in active voice, with short sentences.** Say what to do, where to
  click and what to check.
- **Titles and headings in sentence case** ("Step-by-step installation", not "Step-By-Step
  Installation"). No emoji in headings. Every page has a `description` (one sentence, used by search
  engines and search cards) and a short `sidebar.label`.
- **Use the same Markdown in both languages.** Same headings in the same order, same
  `<a id="…">` anchors, same code blocks. Anchors keep the original Portuguese ids so that links
  (and the scripts that print them) do not break.
- **Interface labels.** The panel interface exists in English and Portuguese, and the dictionaries
  live in `apps/web/src/locales/en/` and `apps/web/src/locales/pt-BR/`. Quote each label **in the
  language of the page**, exactly as it appears on screen, in bold: **Settings → Backups** on an
  English page, **Configurações → Backups** on a Portuguese page. Never translate a label by hand and
  never invent one: copy it from the dictionary of that language (the same key has the English and the
  Portuguese text). Do not add the other language in parentheses; the other language's page has it.
  When a label is ambiguous (the same Portuguese word has two English labels), pick the one of the
  screen you are describing. If a label in the interface looks wrong or inconsistent, fix the
  interface and then the page; do not work around it in the docs.
- **Messages that come from the server.** Some texts are written by the server and are still
  Portuguese in both interface languages (health-check and security-scan results, deploy and DNS-check
  messages, mail server status, certificate errors, alerts, audit details, backup records, the
  details of the roadmap steps and many error messages; the inventory is in
  `comoFuncionaSistema/_i18n-servidor-fase2.tsv`). The recovery kit text is not one of them: the
  browser builds it (`buildRecoveryKit` in `packages/core/src/backups.ts`) and it is fixed in
  Portuguese in both interface languages. When a page quotes one, keep the Portuguese text
  and say in the same sentence that it comes from the server and is still in Portuguese; on an
  English page add the English meaning in parentheses. Remove this rule and the notes when the
  server messages are translated.
- **Interface note.** Every page that quotes the interface starts with the same `> [!NOTE]`:
  "Interface language", saying that the panel exists in English and Portuguese, which language the
  labels on the page are in, and which categories of server message are still in Portuguese. The
  note links to the "Language" paragraph of the complete guide (`#idioma-da-interface`).
- **Words the user types.** Some confirmation words depend on the language of the interface (for
  example `panel`/`email` or `painel`/`e-mail` to restore, and `restart` or `recomeçar` to start the
  wizard over). Read them from the dictionary (`restore.confirmWord.*`, `done.restart.confirmWord`)
  and write both when the page is about that action.
- **Scripts and installer.** The installer and the shell scripts only print in Portuguese. Keep the Portuguese text in samples of installer or script
  output, and add a one-line English summary next to it.
- **Placeholders** are written in capitals with underscores and are translated: `YOUR_IP` /
  `SEU_IP`, `YOUR_USER` / `SEU_USUARIO`. Examples use `example.com`, `203.0.113.10` and the
  `203-0-113-10.sslip.io` form. Never put a real IP, a client domain, a token or an endpoint in a
  page.
- **Callouts** use GitHub alerts (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`).
- **Links between guides** are relative links to the `.md` file (`../guides/operations.md#anchor`).
- **Do not overstate security.** Say what the panel does and what it requires. Avoid "all",
  "never" and "always" unless the code guarantees it.

## Glossary (English)

| Use | Instead of | Portuguese |
|---|---|---|
| panel | dashboard (only for the Dashboard page) | painel |
| project | app, site (unless it is a static site) | projeto |
| deploy (noun and verb: "to deploy", "a deploy") | deployment, publish | deploy |
| domain, subdomain | hostname (except for mail hosts) | domínio, subdomínio |
| certificate (HTTPS/TLS) | cert, SSL certificate | certificado |
| backup (noun), "to back up" (verb) | bkp, snapshot | backup, fazer backup |
| restore | recover (use "recover" only for access) | restaurar |
| mail server | email server (Stalwart) | servidor de e-mail |
| mailbox | email account, inbox (inbox is the folder) | caixa |
| email (noun, no hyphen) | e-mail, mail (except in `mail.<domain>`) | e-mail |
| webmail | web mail | webmail |
| VPS | server (when the machine is meant), host | VPS |
| host | VPS (only when contrasting with a container) | host |
| container | docker | container |
| setup token | install token, wizard token | setup token |
| setup wizard, wizard | assistant | assistente de configuração, wizard |
| hardening | securing | hardening |
| two-factor authentication (2FA) | two-step verification, MFA (2FA is fine in prose and in code samples) | verificação em duas etapas |
| recovery code | backup code | código de recuperação |
| recovery kit | rescue kit | kit de recuperação |
| external storage, external copy | remote storage, cloud | armazenamento externo, cópia externa |
| baseline snapshot | reference snapshot | retrato de referência |
| Sending (the menu), queue, reputation | Sent mail, outbox | Envios, fila, reputação |
| audit log | audit (alone) | auditoria |
| time zone | timezone | fuso horário |
| proxy | reverse proxy (Caddy is the proxy) | proxy |
| sign in, sign out (verbs); sign-in (noun and adjective: "the sign-in screen") | log in, login, signin | entrar, sair; login |

This glossary follows `apps/web/src/locales/GLOSSARY.md`, which is the source for every term that
is also an interface label. If the two disagree, fix this table. The English term of a label is
the one the interface shows, so a guide never needs a different word for the same thing.

Where the Portuguese guides and the Portuguese interface differ today, the interface wins for
labels (quote it as it is) and the guides keep their own wording in prose: the guides write
"container", as the Portuguese dictionaries do; only `GLOSSARY.md` says "contêiner".
The Portuguese interface calls two-factor authentication "Verificação em duas etapas",
while its glossary says "autenticação em dois fatores".

Use "TWS Panel" for the product and "the panel" afterwards. Do not write "paas".
