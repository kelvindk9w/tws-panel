// Lê o endereço do site de documentação em site/astro.config.mjs (`site` + `base`).
// É a ÚNICA fonte do endereço: os scripts de documentação derivam tudo daqui.
// Sem dependências. Usado por check-site-url.mjs e check-doc-links.mjs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'site/astro.config.mjs';

// `root` existe para os testes lerem uma config de uma pasta temporária; os scripts usam o padrão.
export function readSiteConfig(root = ROOT) {
  const text = readFileSync(path.join(root, CONFIG), 'utf8');
  const site = /^\s*site:\s*'([^']+)'/m.exec(text)?.[1];
  const base = /^const base = '([^']*)'/m.exec(text)?.[1];
  if (!site || base === undefined) {
    throw new Error(`${CONFIG}: não achei \`site: '…'\` e \`const base = '…'\`. Ajuste scripts/site-config.mjs se o formato mudou.`);
  }
  const origin = site.replace(/\/+$/, '');
  const basePath = base.replace(/\/+$/, '');
  return {
    config: CONFIG,
    origin, // origem do site
    host: new URL(origin).host, // host
    basePath, // caminho base
    root: `${origin}${basePath}/`, // endereço raiz, com barra final
  };
}

// Marca de exceção, válida só como COMENTÁRIO na linha (`<!-- site-url-ignore -->`,
// `// site-url-ignore` ou `# site-url-ignore`, depois de espaço ou no começo da linha) e só para
// links de TERCEIROS em *.github.io. Nunca vale dentro de uma URL (`?site-url-ignore`,
// `#site-url-ignore`) nem como parte de outra palavra, e não desliga a checagem do próprio site.
export function hasIgnoreComment(text) {
  return /<!--\s*site-url-ignore\s*-->|(?:^|\s)(?:\/\/|#)\s*site-url-ignore(?=\s|$)/.test(text);
}

// Caminho absoluto do site (`/tws-panel/en/guides/x/#ancora`, já com o base) → existe a página-fonte
// em site/src/content/docs (`.md`/`.mdx`, solta ou como `index` da pasta). Só o base sozinho é a
// página inicial (site/src/pages/index.astro). Fora do base, ou com `..` no caminho, é falso.
// Usado por check-doc-links.mjs nos links `link:` do frontmatter e nos `](/…)` do Markdown.
export function sitePageExists(urlPath, { basePath, root = ROOT }) {
  const prefix = `${basePath}/`;
  const clean = urlPath.split('#')[0].split('?')[0];
  if (clean !== basePath && !clean.startsWith(prefix)) return false;
  const slug = clean.slice(prefix.length).replace(/\/+$/, '');
  if (slug.split('/').includes('..')) return false;
  const candidates = slug
    ? [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`].map((c) => `site/src/content/docs/${c}`)
    : ['site/src/pages/index.astro'];
  return candidates.some((c) => existsSync(path.join(root, c)));
}
