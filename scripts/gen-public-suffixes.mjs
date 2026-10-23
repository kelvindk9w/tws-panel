#!/usr/bin/env node
/**
 * gen-public-suffixes.mjs — gera packages/core/src/public-suffixes.generated.ts a partir da
 * cópia fixada da Public Suffix List (packages/core/psl/public_suffix_list.dat, MPL-2.0).
 *
 * O módulo guarda o que o painel usa para achar o domínio registrável de um nome
 * (example.com.br, joao.silva.nom.br): TODAS as regras da seção ICANN (as em Unicode viram
 * punycode) e as entradas da CentralNic (br.com, us.com, uk.net...), que a PSL lista na seção
 * privada; o resto da seção privada (eu.org, github.io...) vai à parte, em PSL_PRIVATE_RULES.
 * Nunca à mão: para atualizar a lista,
 *   1. baixe https://publicsuffix.org/list/public_suffix_list.dat para packages/core/psl/;
 *   2. node scripts/gen-public-suffixes.mjs
 * Um teste (packages/core/tests/public-suffixes.test.ts) falha se o módulo divergir da cópia.
 *
 * Uso: node scripts/gen-public-suffixes.mjs [--stdout]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRADA = resolve(RAIZ, "packages/core/psl/public_suffix_list.dat");
const SAIDA = resolve(RAIZ, "packages/core/src/public-suffixes.generated.ts");

/** Rótulo a rótulo para punycode (curinga e exceção preservados); "" se não converter. */
function paraAscii(regra) {
  const excecao = regra.startsWith("!");
  const rotulos = regra.replace(/^!/, "").split(".");
  const out = [];
  for (const r of rotulos) {
    // só rótulos com Unicode convertem (domainToASCII("0") viraria "0.0.0.0")
    const a = r === "*" || /^[\x00-\x7f]*$/.test(r) ? r : domainToASCII(r);
    if (a === "") return "";
    out.push(a);
  }
  return `${excecao ? "!" : ""}${out.join(".")}`;
}

function agrupar(mapa, regra) {
  const excecao = regra.startsWith("!");
  const rotulos = regra.replace(/^!/, "").split(".");
  const tld = rotulos[rotulos.length - 1];
  if (rotulos.length < 2) return;
  if (!mapa.has(tld)) mapa.set(tld, new Set());
  mapa.get(tld).add(`${excecao ? "!" : ""}${rotulos.slice(0, -1).join(".")}`);
}

function emitir(mapa) {
  return [...mapa.keys()].sort().map((t) => `  ${JSON.stringify(t)}: ${JSON.stringify([...mapa.get(t)].sort().join(" "))},`).join("\n");
}

export function generate(texto) {
  const versao = /^\/\/ VERSION: (.+)$/m.exec(texto)?.[1]?.trim() ?? "desconhecida";
  const commit = /^\/\/ COMMIT: (.+)$/m.exec(texto)?.[1]?.trim() ?? "desconhecido";
  const publicas = new Map();
  const privadas = new Map();
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
    if (secao === "") continue;
    const regra = paraAscii(linha.split(/\s+/)[0]);
    if (!/^[!*]?[a-z0-9.*-]+$/.test(regra)) continue;
    const tld = regra.replace(/^!/, "").split(".").pop();
    if (secao === "icann") {
      if (tld.length === 2) paises.add(tld);
      agrupar(publicas, regra);
    } else if (centralnic) agrupar(publicas, regra);
    else agrupar(privadas, regra);
  }
  return `/**
 * GERADO por scripts/gen-public-suffixes.mjs — não edite à mão.
 *
 * Public Suffix List (https://publicsuffix.org), distribuída sob a Mozilla Public
 * License 2.0 (https://mozilla.org/MPL/2.0/): a seção ICANN inteira (regras em Unicode já em
 * punycode), as entradas da CentralNic e, à parte, a seção privada. Cópia fixada:
 * packages/core/psl/public_suffix_list.dat (cabeçalho e licença preservados).
 * Atualizar: baixar a lista nova para lá e rodar o script.
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
${emitir(publicas)}
};

/**
 * Seção PRIVADA da PSL (registros gratuitos e hospedagens: eu.org, github.io...), no mesmo
 * formato. Um nome sob um desses sufixos não tem apex que o painel saiba dizer: nome completo, sem par.
 */
export const PSL_PRIVATE_RULES: Readonly<Record<string, string>> = {
${emitir(privadas)}
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
