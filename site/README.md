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
URLs and numbers. Only the prose, the code comments and the placeholders are translated.

## Adding a language

1. Copy `src/content/docs/en/` to `src/content/docs/<code>/` (for example `es`) and translate it.
   A page that is missing is shown in English, with a notice.
2. Add one entry to `locales` in `astro.config.mjs`, for example `es: { label: 'Español', lang: 'es' }`.
3. Add the translated section labels in `sidebar`. The key of `translations` is the `lang` value of
   the locale, not the locale key: for `pt-br` it is `'pt-BR'`, so for the example it is
   `translations: { es: '…' }` because `lang` is `'es'`. In `src/pages/index.astro`, add the
   language check that redirects the site root.
4. Add a block for the language in `src/content/docs/404.md` (a `<div data-lang-block="<code>">`)
   and the matching entry in the script at the end of that file. GitHub Pages serves a single
   404 page, and the script chooses the block from the first folder of the address.

Sidebar entries use slugs, so they are the same in every language.

## Editorial rules

- **Write in the imperative, in active voice, with short sentences.** Say what to do, where to
  click and what to check.
- **Titles and headings in sentence case** ("Step-by-step installation", not "Step-By-Step
  Installation"). No emoji in headings. Every page has a `description` (one sentence, used by search
  engines and search cards) and a short `sidebar.label`.
- **Use the same Markdown in both languages.** Same headings in the same order, same
  `<a id="…">` anchors, same code blocks. Anchors keep the original Portuguese ids so that links
  (and the scripts that print them) do not break.
- **Interface labels.** The panel interface is Portuguese for now. Quote the label exactly as it
  appears on screen, in bold, and add the English meaning in parentheses on first mention in
  each section: **Configurações → Backups** (Settings → Backups). Never invent an English label that
  does not exist on screen. Every page that mentions the interface starts with the same note saying
  that the interface is being translated.
- **Scripts that print in Portuguese.** Keep the Portuguese text in samples of installer or script
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
| wizard | assistant | wizard, assistente |
| hardening | securing | hardening |
| two-step verification | 2FA, MFA (2FA is fine inside a code sample) | verificação em duas etapas |
| recovery codes | backup codes | códigos de recuperação |
| recovery kit | rescue kit | kit de recuperação |
| external storage | remote storage, cloud | armazenamento externo |
| time zone | timezone | fuso horário |
| proxy | reverse proxy (Caddy is the proxy) | proxy |
| log in (verb), login (noun) | signin | entrar, login |

Use "TWS Panel" for the product and "the panel" afterwards. Do not write "paas".
