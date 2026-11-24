#!/usr/bin/env node
// Confere que todo endereço absoluto do site de documentação escrito nos arquivos do repositório
// (READMEs, CONTRIBUTING, SECURITY, .github/, docs/…) bate com o `site` + `base` de
// site/astro.config.mjs. Serve para trocar o domínio do site sem esquecer nenhum arquivo (a troca
// muda também EXPECTED_SITE/EXPECTED_BASE, abaixo).
//
// Considera "endereço do site" qualquer URL cujo host seja o configurado ou termine em
// `.github.io` (o endereço antigo, depois de uma troca de domínio, continua sendo pego).
// Links para github.com/<repo> não são endereço do site.
//
// Confere também a própria config, contra o modelo de publicação do GitHub Pages: o domínio
// docs.tws.tec.br fica no site de USUÁRIO da conta (<usuário>.github.io) e todo site de projeto sem
// domínio próprio o herda como https://docs.tws.tec.br/<repositório>/. Por isso exige `site` igual a
// EXPECTED_SITE, base igual a EXPECTED_BASE (o nome do repositório) e AUSÊNCIA de site/public/CNAME:
// um domínio próprio neste repositório sobreporia o herdado e tiraria o site da pasta /tws-panel/.
//
// Atenção: um link de terceiros em *.github.io (outro projeto hospedado no GitHub Pages) também
// reprova. Exceção só para esse caso: um comentário na mesma linha (`<!-- site-url-ignore -->` em
// Markdown; `// site-url-ignore` ou `# site-url-ignore` em código/YAML). A marca não vale dentro de
// uma URL nem como parte de outra palavra e nunca desliga a checagem do próprio site.
//
// Uso: node scripts/check-site-url.mjs          (ou: pnpm docs:site-url)
//      node scripts/check-site-url.mjs --list   (lista os arquivos que têm o endereço absoluto)
// Sai com código 1 se a config fugir do esperado ou algum endereço não corresponder a ela.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, hasIgnoreComment, readSiteConfig } from './site-config.mjs';

/** Endereço do site herdado do site de usuário da conta (sem barra final). */
export const EXPECTED_SITE = 'https://docs.tws.tec.br';
/** Pasta do site de projeto no domínio herdado: o nome do repositório (sem barra final). */
export const EXPECTED_BASE = '/tws-panel';
/** Arquivo que daria a este repositório um domínio próprio; não pode existir. */
export const CNAME = 'site/public/CNAME';

/**
 * Problemas da config do site (`cfg` vem de readSiteConfig). `cnameExists` diz se site/public/CNAME
 * existe. Devolve uma lista de mensagens; vazia quando está tudo certo.
 */
export function siteSetupProblems(cfg, { cnameExists }) {
  const problems = [];
  if (cfg.origin !== EXPECTED_SITE)
    problems.push(`${cfg.config}: site é "${cfg.origin}", mas tem de ser "${EXPECTED_SITE}" (o domínio herdado do site de usuário da conta)`);
  if (cfg.basePath !== EXPECTED_BASE)
    problems.push(`${cfg.config}: base é "${cfg.basePath || '/'}", mas tem de ser "${EXPECTED_BASE}/" (a pasta do repositório no domínio herdado)`);
  if (cnameExists)
    problems.push(`${CNAME}: existe, mas este repositório não pode ter domínio próprio (ele sobreporia o domínio herdado); apague o arquivo`);
  return problems;
}

const SKIP = [/^comoFuncionaSistema\//, /^docs\/internal\/phase1-evidence\//, /node_modules\//, /(^|\/)pnpm-lock\.yaml$/, /^scripts\/check-site-url\.mjs$/];
const EXT = /\.(md|mdx|ya?ml|json|mjs|astro|html|ts|tsx|mts)$/;

function main() {
  const cfg = readSiteConfig();
  const list = process.argv.includes('--list');

  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && EXT.test(f) && !SKIP.some((re) => re.test(f)) && existsSync(path.join(ROOT, f)));

  const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?[^\s)>"'`\]<]*/g;
  const isSiteHost = (host) => host === cfg.host || host.endsWith('.github.io');

  const problems = [];
  const holders = new Map();

  problems.push(...siteSetupProblems(cfg, { cnameExists: existsSync(path.join(ROOT, CNAME)) }));
  for (const file of files) {
    if (file === cfg.config) continue; // é a fonte
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      const ignorable = hasIgnoreComment(text);
      for (const m of text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:]+$/, '');
        let u;
        try {
          u = new URL(url);
        } catch {
          continue;
        }
        if (!isSiteHost(u.host)) continue;
        if (ignorable && u.host !== cfg.host) continue; // terceiro em *.github.io, com a marca em comentário
        const withSlash = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
        const inside = u.origin === cfg.origin && (u.pathname === cfg.basePath || withSlash.startsWith(`${cfg.basePath}/`));
        if (!inside) problems.push(`${file}:${i + 1}: ${url} não corresponde a ${cfg.root} (veja ${cfg.config})`);
        else holders.set(file, (holders.get(file) ?? 0) + 1);
      }
    });
  }

  if (list) {
    for (const [f, n] of [...holders].sort()) console.log(`${f} (${n})`);
    return 0;
  }
  if (problems.length) {
    console.error(`${problems.length} problema(s) no endereço do site:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\nEndereço configurado: ${cfg.root}`);
    return 1;
  }
  console.log(`OK: ${holders.size} arquivo(s) com o endereço do site, todos em ${cfg.root}`);
  return 0;
}

// Só roda quando chamado como script; importado (nos testes), expõe só as funções acima.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
