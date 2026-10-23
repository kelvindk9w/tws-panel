#!/usr/bin/env node
/**
 * gen-public-suffixes.mjs — gera packages/core/src/public-suffixes.generated.ts a partir da
 * cópia fixada da Public Suffix List (packages/core/data/public_suffix_list.dat, MPL-2.0).
 *
 * O módulo guarda o que o painel usa para achar o domínio registrável de um nome
 * (example.com.br, joao.silva.nom.br): TODAS as regras da seção ICANN e as entradas da
 * CentralNic (br.com, us.com, uk.net...), que a PSL lista na seção privada. A seção privada
 * de hospedagens (github.io, vercel.app...) fica de fora: o painel a trata à parte.
 * Nunca à mão: para atualizar a lista,
 *   1. baixe https://publicsuffix.org/list/public_suffix_list.dat para packages/core/data/;
 *   2. node scripts/gen-public-suffixes.mjs
 * Um teste (packages/core/tests/public-suffixes.test.ts) falha se o módulo divergir da cópia.
 *
 * Uso: node scripts/gen-public-suffixes.mjs [--stdout]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRADA = resolve(RAIZ, "packages/core/data/public_suffix_list.dat");
const SAIDA = resolve(RAIZ, "packages/core/src/public-suffixes.generated.ts");

export function generate(texto) {
  const versao = /^\/\/ VERSION: (.+)$/m.exec(texto)?.[1]?.trim() ?? "desconhecida";
  const commit = /^\/\/ COMMIT: (.+)$/m.exec(texto)?.[1]?.trim() ?? "desconhecido";
  const porTld = new Map();
  const paises = new Set();
  let secao = "";
  let centralnic = false;
  for (const bruta of texto.split("\n")) {
    const linha = bruta.trim();
    if (linha.startsWith("// ===BEGIN ICANN")) secao = "icann";
    else if (linha.startsWith("// ===BEGIN PRIVATE")) secao = "private";
    else if (linha.startsWith("// ===END")) secao = "";
    if (linha === "") {
      centralnic = false;
      continue;
    }
    if (linha.startsWith("//")) {
      if (secao === "private" && linha.startsWith("// CentralNic :")) centralnic = true;
      continue;
    }
    if (!(secao === "icann" || (secao === "private" && centralnic))) continue;
    const regra = linha.split(/\s+/)[0];
    if (!/^[!*]?[a-z0-9.*-]+$/.test(regra)) continue; // IDN em Unicode: o painel só vê punycode
    const nome = regra.replace(/^!/, "");
    const rotulos = nome.split(".");
    const tld = rotulos[rotulos.length - 1];
    if (secao === "icann" && tld.length === 2) paises.add(tld);
    if (rotulos.length < 2) continue;
    if (!porTld.has(tld)) porTld.set(tld, new Set());
    const grupo = porTld.get(tld);
    grupo.add(`${regra.startsWith("!") ? "!" : ""}${rotulos.slice(0, -1).join(".")}`);
  }
  const corpo = [...porTld.keys()].sort().map((t) => `  ${t}: ${JSON.stringify([...porTld.get(t)].sort().join(" "))},`).join("\n");
  return `/**
 * GERADO por scripts/gen-public-suffixes.mjs — não edite à mão.
 *
 * Seção ICANN da Public Suffix List (mais a CentralNic) (https://publicsuffix.org), distribuída sob a Mozilla Public
 * License 2.0 (https://mozilla.org/MPL/2.0/). Cópia fixada: packages/core/data/public_suffix_list.dat
 * (cabeçalho e licença preservados). Atualizar: baixar a lista nova e rodar o script.
 */

/** Versão e commit da cópia da PSL usada na geração. */
export const PSL_VERSION = ${JSON.stringify(versao)};
export const PSL_COMMIT = ${JSON.stringify(commit)};

/** TLDs de país (2 letras) que a PSL conhece: um 2 letras fora daqui é desconhecido e o sufixo, incerto. */
export const PSL_COUNTRY_TLDS: readonly string[] = ${JSON.stringify([...paises].sort())};

/**
 * Regras por TLD, sem o TLD no fim, separadas por espaço: "com.br" vira "com" em "br".
 * "*.x" é curinga e "!x" é exceção. Inclui as entradas da CentralNic (br.com, uk.net...).
 */
export const PSL_RULES: Readonly<Record<string, string>> = {
${corpo}
};
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const saida = generate(readFileSync(ENTRADA, "utf8"));
  if (process.argv.includes("--stdout")) process.stdout.write(saida);
  else {
    writeFileSync(SAIDA, saida);
    console.log(`gerado ${SAIDA} (${saida.length} bytes)`);
  }
}
