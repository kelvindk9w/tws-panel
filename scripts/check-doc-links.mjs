#!/usr/bin/env node
// Verifica os links internos da documentação (sem rede, sem dependências).
//
// Cobre todos os .md/.mdx versionados (README*, ROADMAP, CONTRIBUTING, docs/,
// site/src/content/docs/…) e confere, para cada link ou imagem:
//   - caminho relativo → o arquivo existe;
//   - âncora (#...)    → existe um título ou <a id> correspondente no destino;
//   - URL do próprio repositório (github.com/<repo>/blob|tree/main/…) → o
//     arquivo/pasta existe localmente;
//   - `link: /tws-panel/…` do frontmatter das páginas iniciais → a página existe.
// Links http(s) externos não são acessados.
//
// Uso: node scripts/check-doc-links.mjs   (ou: pnpm docs:links)
// Sai com código 1 se houver link quebrado.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = /^https:\/\/github\.com\/kelvindk9w\/tws-panel\/(?:blob|tree)\/main\/?(.*)$/;
const SITE_BASE = '/tws-panel/';
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

    const hero = /^\s*link:\s*(\/tws-panel\/\S+)\s*$/.exec(text);
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
        if (!/^\/tws-panel\//.test(url)) report(file, line, `caminho absoluto não resolvível (${url})`);
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

if (problems.length) {
  console.error(`${problems.length} problema(s) em ${files.length} arquivo(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`OK: ${files.length} arquivo(s) Markdown, nenhum link interno quebrado.`);
