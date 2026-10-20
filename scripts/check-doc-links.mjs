#!/usr/bin/env node
// Verifica os links internos da documentação (sem rede, sem dependências).
//
// Cobre todos os .md/.mdx versionados (README*, ROADMAP, CONTRIBUTING, docs/,
// site/src/content/docs/…) e confere, para cada link ou imagem:
//   - caminho relativo → o arquivo existe;
//   - âncora (#...)    → existe um título ou <a id> correspondente no destino;
//   - URL do próprio repositório (github.com/<repo>/blob|tree/main/…) → o
//     arquivo/pasta existe localmente;
//   - `link: /tws-panel/…` do frontmatter das páginas iniciais → a página existe;
//   - URL absoluta do próprio site (READMEs, .github/…; o endereço vem de site/astro.config.mjs)
//     → existe a rota (e a âncora, se houver) no build em site/dist. Sem build, essa parte é
//     pulada com um aviso; com --require-dist, a falta do build é erro.
// Links http(s) externos não são acessados.
//
// Uso: node scripts/check-doc-links.mjs [--require-dist]   (ou: pnpm docs:links)
// Sai com código 1 se houver link quebrado.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readSiteConfig } from './site-config.mjs';

const SITE = readSiteConfig();
const DIST = path.join(ROOT, 'site', 'dist');
const REQUIRE_DIST = process.argv.includes('--require-dist');
const REPO_URL = /^https:\/\/github\.com\/kelvindk9w\/tws-panel\/(?:blob|tree)\/main\/?(.*)$/;
const SITE_BASE = `${SITE.basePath}/`;
const SKIP = [/^comoFuncionaSistema\//, /^docs\/internal\/phase1-evidence\//, /node_modules\//];

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '*.md', '*.mdx'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.some((re) => re.test(f)) && existsSync(path.join(ROOT, f)));

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

function stripInline(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim();
}

const anchorCache = new Map();
function anchorsOf(rel) {
  if (anchorCache.has(rel)) return anchorCache.get(rel);
  const set = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of readFileSync(path.join(ROOT, rel), 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1]);
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slugify(stripInline(h[1]));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  anchorCache.set(rel, set);
  return set;
}

const problems = [];
const report = (file, line, msg) => problems.push(`${file}:${line}: ${msg}`);

function checkTarget(file, line, targetPath, hash, label) {
  const abs = path.join(ROOT, targetPath);
  if (!existsSync(abs)) return report(file, line, `${label}: arquivo não existe (${targetPath})`);
  if (hash && statSync(abs).isFile() && /\.mdx?$/.test(targetPath)) {
    const wanted = decodeURIComponent(hash.slice(1));
    if (!anchorsOf(targetPath).has(wanted))
      report(file, line, `${label}: âncora inexistente (${targetPath}${hash})`);
  }
}

for (const file of files) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  let fence = false;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    if (fence) return;
    const noCode = text.replace(/`[^`]*`/g, '');

    const hero = new RegExp(`^\\s*link:\\s*(${SITE_BASE}\\S+)\\s*$`).exec(text);
    if (hero) {
      const slug = hero[1].slice(SITE_BASE.length).replace(/\/$/, '');
      const candidates = [`site/src/content/docs/${slug}.md`, `site/src/content/docs/${slug}.mdx`, `site/src/content/docs/${slug}/index.md`];
      if (!candidates.some((c) => existsSync(path.join(ROOT, c))))
        report(file, line, `link do frontmatter sem página (${hero[1]})`);
    }

    for (const m of noCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const url = m[1];
      if (/^(mailto:|tel:|data:)/i.test(url)) continue;
      const repoMatch = REPO_URL.exec(url.split('#')[0]);
      if (repoMatch) {
        const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
        checkTarget(file, line, decodeURIComponent(repoMatch[1]).replace(/\/$/, '') || '.', hash, 'link do repositório');
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue;
      if (url.startsWith('/')) {
        if (!url.startsWith(SITE_BASE)) report(file, line, `caminho absoluto não resolvível (${url})`);
        continue;
      }
      const hashAt = url.indexOf('#');
      const target = decodeURIComponent(hashAt === -1 ? url : url.slice(0, hashAt));
      const hash = hashAt === -1 ? '' : url.slice(hashAt);
      const resolved = target === '' ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      checkTarget(file, line, resolved.replace(/\/$/, '') || '.', hash, 'link');
    }
  });
}

// URLs absolutas do site: a rota (e a âncora) precisam existir no build.
const distHtml = new Map();
function distIds(file) {
  if (!distHtml.has(file)) {
    const ids = new Set();
    for (const m of readFileSync(file, 'utf8').matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
    distHtml.set(file, ids);
  }
  return distHtml.get(file);
}
const haveDist = existsSync(DIST);
if (!haveDist) {
  if (REQUIRE_DIST) problems.push('site/dist não existe: rode `pnpm docs:build` antes (--require-dist)');
  else console.warn('Aviso: site/dist não existe; URLs absolutas do site não foram conferidas contra o build.');
}
const absFiles = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  // Markdown/YAML do repositório e o código TS do painel que monta links para o site
  // (apps/web/src, fora dos testes).
  .filter(
    (f) =>
      f &&
      (/\.(md|mdx|ya?ml)$/.test(f) || (/^apps\/web\/src\/.*\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) &&
      !SKIP.some((re) => re.test(f)) &&
      existsSync(path.join(ROOT, f)),
  );
const SITE_ORIGIN = new URL(SITE.origin).origin;
// Idiomas publicados = pastas de primeiro nível do build com index.html (en, pt-br…).
const LANGS = haveDist
  ? readdirSync(DIST).filter((d) => /^[a-z]{2}(-[a-z]{2})?$/.test(d) && existsSync(path.join(DIST, d, 'index.html')))
  : [];
let absCount = 0;

// Confere uma URL já interpretada: origem + caminho normalizados (host em maiúsculas ou :443 também valem).
function checkSiteUrl(file, line, shown, u) {
  if (u.origin !== SITE_ORIGIN) return;
  if (u.pathname !== SITE.basePath && !u.pathname.startsWith(`${SITE.basePath}/`)) return;
  absCount++;
  if (!haveDist) return;
  const route = decodeURIComponent(u.pathname.slice(SITE.basePath.length)).replace(/^\//, '');
  const hash = decodeURIComponent(u.hash.slice(1));
  if (route !== '' && !route.endsWith('/')) {
    report(file, line, `URL do site sem barra final (${shown}); o site usa trailingSlash: 'always'`);
    return;
  }
  const html = path.join(DIST, route, 'index.html');
  if (!existsSync(html)) report(file, line, `URL do site sem rota no build (${shown})`);
  else if (hash && !distIds(html).has(hash)) report(file, line, `URL do site com âncora inexistente no build (${shown})`);
}

// O valor literal de SITE_URL no código do painel tem de ser idêntico a origem + base da config
// (sem barra final: os modelos acrescentam "/", e uma barra a mais geraria "//").
const SITE_URL_EXPECTED = `${SITE.origin}${SITE.basePath}`;
function checkSiteUrlConstant(file, source) {
  const usesTemplate = /\$\{SITE_URL\}/.test(source);
  const def = /\b(?:const|let|var)\s+SITE_URL\b[^=\n]*=\s*(["'`])([^"'`\n]*)\1\s*[;,\n]/.exec(source);
  if (def) {
    const line = source.slice(0, def.index).split('\n').length;
    if (def[2] !== SITE_URL_EXPECTED)
      report(file, line, `SITE_URL = "${def[2]}" difere da config; o esperado é exatamente "${SITE_URL_EXPECTED}" (sem barra final), veja ${SITE.config}`);
  } else if (usesTemplate && !/\bimport\b[^;]*\bSITE_URL\b[^;]*\bfrom\b/.test(source)) {
    report(file, 1, 'usa ${SITE_URL}, mas não o define como literal de aspas neste arquivo nem o importa');
  }
}

for (const file of absFiles) {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  if (/\.tsx?$/.test(file)) checkSiteUrlConstant(file, source);
  source
    .split('\n')
    .forEach((text, i) => {
      for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?[^\s)>"'`\]<]*/g)) {
        const url = m[0].replace(/[.,;:]+$/, '');
        let u;
        try {
          u = new URL(url);
        } catch {
          continue;
        }
        checkSiteUrl(file, i + 1, url, u);
      }
      // Código TS que monta o link por concatenação: `${SITE_URL}/${idioma}/guides/help/`.
      // Só o idioma pode ser dinâmico; o resto do caminho tem de ser literal. Cada idioma
      // publicado é expandido e conferido contra o build.
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return;
      for (const m of text.matchAll(/\$\{SITE_URL\}(\/[^`"']*)/g)) {
        const tail = m[1];
        const lang = /^\/\$\{[^}]*\}(\/.*)$/.exec(tail);
        const literal = lang ? lang[1] : tail;
        if (/\$\{/.test(literal)) {
          report(file, i + 1, `link do site com mais de um trecho dinâmico (${m[0]}); só o idioma pode ser dinâmico`);
          continue;
        }
        for (const l of lang ? LANGS : ['']) {
          const route = lang ? `/${l}${literal}` : literal;
          checkSiteUrl(file, i + 1, `${SITE.origin}${SITE.basePath}${route}`, new URL(`${SITE.origin}${SITE.basePath}${route}`));
        }
      }
    });
}

if (problems.length) {
  console.error(`${problems.length} problema(s) em ${files.length} arquivo(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `OK: ${files.length} arquivo(s) Markdown, nenhum link interno quebrado${haveDist ? `; ${absCount} URL(s) absoluta(s) do site conferida(s) contra o build` : ''}.`,
);
