// Confere o HTML gerado em site/dist: falha se sobrar um alerta do GitHub
// (`[!NOTE]` etc.) como texto cru, e se os asides não saírem com o tipo certo.
// Uso: pnpm --filter site build && pnpm --filter site check:build
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const docsRoot = path.resolve(dist, '..', 'src', 'content', 'docs');

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'pagefind' && name !== '_astro') walk(p, ext, out);
    } else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const problems = [];
const stripCode = (html) => html.replace(/<(pre|code)[\s\S]*?<\/\1>/g, '');

// 1) nenhum alerta literal fora de blocos de código
for (const f of walk(dist, '.html')) {
  const html = stripCode(readFileSync(f, 'utf8'));
  const m = html.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi);
  if (m) problems.push(`${path.relative(dist, f)}: ${m.length} alerta(s) literal(is) ${[...new Set(m)].join(' ')}`);
}

// 2) a contagem de asides por tipo bate com os alertas dos fontes (fora de blocos de código)
const expectAside = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'note', WARNING: 'caution', CAUTION: 'danger' };
for (const lang of ['en', 'pt-br']) {
  const want = { note: 0, tip: 0, caution: 0, danger: 0 };
  for (const f of walk(path.join(docsRoot, lang), '.md')) {
    let fence = false;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) continue;
      const m = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(line);
      if (m) want[expectAside[m[1].toUpperCase()]]++;
    }
  }
  const got = { note: 0, tip: 0, caution: 0, danger: 0 };
  for (const f of walk(path.join(dist, lang), '.html')) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/class="starlight-aside starlight-aside--(note|tip|caution|danger)"/g)) got[m[1]]++;
  }
  // asides escritos com :::tipo nos fontes somariam ao "got"; hoje não há nenhum
  for (const k of Object.keys(want))
    if (got[k] < want[k]) problems.push(`${lang}: esperados ${want[k]} aside(s) "${k}", gerados ${got[k]}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('OK: sem alertas literais e com os asides esperados.');
