#!/usr/bin/env node
/**
 * check-commit-authors.mjs — reprova commits com autor ou coautor de teste ("Teste" / teste@exemplo.com).
 *
 * Esse autor veio de um ambiente de teste que gravava a identidade errada e chegou ao main como
 * `Co-authored-by`. Só vale para o intervalo informado (os commits novos do PR ou do push), nunca para o
 * histórico inteiro. Três commits antigos do dev, que não podem ser reescritos, ficam em
 * scripts/commit-authors-conhecidos.txt: o AUTOR deles é aceito, o resto continua conferido.
 *
 * No merge dev -> main por squash o GitHub acrescenta "Co-authored-by" para cada autor diferente; por isso o
 * job também roda em push (main e dev), conferindo a mensagem do commit que entrou.
 *
 * Uso: node scripts/check-commit-authors.mjs <base>..<head>     (ex.: origin/dev..HEAD)
 *      node scripts/check-commit-authors.mjs <base> <head>      (base só com zeros = branch nova: confere o último commit)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARQUIVO_CONHECIDOS = resolve(RAIZ, "scripts/commit-authors-conhecidos.txt");
const ZEROS = /^0+$/;
const RE_EMAIL = /teste@exemplo\.com/i;
const RE_NOME = /^teste$/i;
const RE_TRAILER = /^co-authored-by:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i;

/** SHAs antigos aceitos (só o autor; o trailer na mensagem desses commits continua conferido). */
export function lerConhecidos(arquivo = ARQUIVO_CONHECIDOS) {
  if (!existsSync(arquivo)) return new Set();
  return new Set(
    readFileSync(arquivo, "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#")),
  );
}

/** Devolve as violações de uma lista de commits { sha, nome, email, mensagem }. Exportada para o teste. */
export function acharAutoresDeTeste(commits, conhecidos = lerConhecidos()) {
  const out = [];
  for (const c of commits) {
    const autorDeTeste = RE_NOME.test(c.nome.trim()) || RE_EMAIL.test(c.email);
    if (autorDeTeste && !conhecidos.has(c.sha.toLowerCase())) out.push(`${c.sha.slice(0, 10)}  autor: ${c.nome} <${c.email}>`);
    for (const linha of c.mensagem.split("\n")) {
      const m = RE_TRAILER.exec(linha.trim());
      if (m && (RE_NOME.test((m[1] ?? "").trim()) || RE_EMAIL.test(m[2] ?? ""))) out.push(`${c.sha.slice(0, 10)}  coautor: ${linha.trim()}`);
    }
  }
  return out;
}

/** Intervalo do git log: base zerada (branch nova no push) confere só o último commit. */
export function montarIntervalo(a, b) {
  if (!b) return a;
  return ZEROS.test(a) ? `${b}^!` : `${a}..${b}`;
}

/** Lê os commits do intervalo (autor, e-mail e mensagem completa). */
export function lerCommits(intervalo, cwd = process.cwd()) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
  const bruto = execFileSync("git", ["log", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e", intervalo], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return bruto
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, nome, email, ...resto] = r.split("\x1f");
      return { sha, nome, email, mensagem: resto.join("\x1f") };
    });
}

export const AJUDA = [
  "Como corrigir:",
  "- commit novo do PR: corrija a identidade (user.name e user.email do Git) e reescreva SÓ os commits do PR;",
  "- linha 'Co-authored-by: Teste' na mensagem do squash (merge dev -> main): APAGUE essa linha no campo de",
  "  mensagem do GitHub antes de confirmar o squash;",
  "- os 3 commits antigos do dev estão em scripts/commit-authors-conhecidos.txt e não geram erro de autor.",
].join("\n");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (!a) {
    console.error("uso: node scripts/check-commit-authors.mjs <base>..<head>");
    process.exit(2);
  }
  const intervalo = montarIntervalo(a, b);
  let v;
  try {
    v = acharAutoresDeTeste(lerCommits(intervalo));
  } catch (err) {
    console.error(`check-commit-authors: não consegui ler o intervalo ${intervalo} (${err.message})`);
    process.exit(2);
  }
  if (v.length) {
    console.error(`Commits com autor ou coautor de teste (${v.length}):\n${v.join("\n")}\n\n${AJUDA}`);
    process.exit(1);
  }
  console.log("check-commit-authors: ok");
}
