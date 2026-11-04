// Lê o endereço do site de documentação em site/astro.config.mjs (`site` + `base`).
// É a ÚNICA fonte do endereço: os scripts de documentação derivam tudo daqui.
// Sem dependências. Usado por check-site-url.mjs e check-doc-links.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'site/astro.config.mjs';

export function readSiteConfig() {
  const text = readFileSync(path.join(ROOT, CONFIG), 'utf8');
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
