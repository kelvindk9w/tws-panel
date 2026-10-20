#!/usr/bin/env node
// Confere que todo endereço absoluto do site de documentação escrito nos arquivos do repositório
// (READMEs, CONTRIBUTING, SECURITY, .github/, docs/…) bate com o `site` + `base` de
// site/astro.config.mjs. Serve para trocar o domínio do site sem esquecer nenhum arquivo.
//
// Considera "endereço do site" qualquer URL cujo host seja o configurado ou termine em
// `.github.io` (o endereço antigo, depois de uma troca de domínio, continua sendo pego).
// Links para github.com/<repo> não são endereço do site.
//
// Atenção: um link de terceiros em *.github.io (outro projeto hospedado no GitHub Pages) também
// reprova. Para declarar uma exceção, escreva `site-url-ignore` na mesma linha (em Markdown, num
// comentário HTML: `<!-- site-url-ignore -->`). O `check-doc-links.mjs` respeita a mesma marca.
//
// Uso: node scripts/check-site-url.mjs          (ou: pnpm docs:site-url)
//      node scripts/check-site-url.mjs --list   (lista os arquivos que têm o endereço absoluto)
// Sai com código 1 se algum endereço não corresponder à configuração.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readSiteConfig } from './site-config.mjs';

const SKIP = [/^comoFuncionaSistema\//, /^docs\/internal\/phase1-evidence\//, /node_modules\//, /(^|\/)pnpm-lock\.yaml$/, /^scripts\/check-site-url\.mjs$/];
const EXT = /\.(md|mdx|ya?ml|json|mjs|astro|html|ts|tsx|mts)$/;

const cfg = readSiteConfig();
const list = process.argv.includes('--list');

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && EXT.test(f) && !SKIP.some((re) => re.test(f)) && existsSync(path.join(ROOT, f)));

const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?[^\s)>"'`\]<]*/g;
const isSiteHost = (host) => host === cfg.host || host.endsWith('.github.io');

const problems = [];
const holders = new Map();
for (const file of files) {
  if (file === cfg.config) continue; // é a fonte
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (text.includes('site-url-ignore')) return; // exceção declarada na própria linha
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:]+$/, '');
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (!isSiteHost(u.host)) continue;
      const withSlash = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
      const inside = u.origin === cfg.origin && (u.pathname === cfg.basePath || withSlash.startsWith(`${cfg.basePath}/`));
      if (!inside) problems.push(`${file}:${i + 1}: ${url} não corresponde a ${cfg.root} (veja ${cfg.config})`);
      else holders.set(file, (holders.get(file) ?? 0) + 1);
    }
  });
}

if (list) {
  for (const [f, n] of [...holders].sort()) console.log(`${f} (${n})`);
  process.exit(0);
}
if (problems.length) {
  console.error(`${problems.length} endereço(s) do site fora da configuração:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nEndereço configurado: ${cfg.root}`);
  process.exit(1);
}
console.log(`OK: ${holders.size} arquivo(s) com o endereço do site, todos em ${cfg.root}`);
