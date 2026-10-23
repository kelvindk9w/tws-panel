/**
 * A lista de sufixos públicos embutida (public-suffixes.generated.ts) vem SÓ da cópia fixada da
 * Public Suffix List (packages/core/data/public_suffix_list.dat), gerada por
 * scripts/gen-public-suffixes.mjs. Aqui: (1) o módulo não diverge da cópia (anti-memória: nada
 * editado à mão), (2) o motor de regras concorda com a PSL para TODA regra ICANN da cópia,
 * (3) tamanho do módulo dentro do orçamento do bundle web e (4) a licença continua no arquivo.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apexOf, isPublicSuffix } from "../src/domain-pair";
import { PSL_COMMIT, PSL_COUNTRY_TLDS, PSL_RULES, PSL_VERSION } from "../src/public-suffixes.generated";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GERADO = path.join(RAIZ, "packages/core/src/public-suffixes.generated.ts");
const COPIA = path.join(RAIZ, "packages/core/data/public_suffix_list.dat");

describe("public-suffixes.generated.ts", () => {
  it("é exatamente o que o script gera a partir da cópia fixada (nada à mão)", () => {
    const regerado = execFileSync("node", [path.join(RAIZ, "scripts/gen-public-suffixes.mjs"), "--stdout"], { encoding: "utf8" });
    expect(readFileSync(GERADO, "utf8")).toBe(regerado);
  });

  it("registra a versão e o commit da cópia, e a licença MPL-2.0", () => {
    const dat = readFileSync(COPIA, "utf8");
    expect(dat).toContain(`// VERSION: ${PSL_VERSION}`);
    expect(dat).toContain(`// COMMIT: ${PSL_COMMIT}`);
    expect(dat).toContain("Mozilla Public");
    const gerado = readFileSync(GERADO, "utf8");
    expect(gerado).toMatch(/Mozilla Public\s+\*?\s*License 2\.0/);
    expect(gerado).toContain("GERADO por scripts/gen-public-suffixes.mjs");
  });

  it("cabe no orçamento do bundle web (módulo de dados <= 60 KB)", () => {
    expect(readFileSync(GERADO).length).toBeLessThanOrEqual(60 * 1024);
  });

  it("cada regra ICANN da cópia vale no motor: o sufixo não é registrável e um rótulo a mais é", () => {
    const dat = readFileSync(COPIA, "utf8");
    const icann = dat.slice(dat.indexOf("===BEGIN ICANN"), dat.indexOf("===END ICANN"));
    let verificadas = 0;
    for (const bruta of icann.split("\n")) {
      const regra = bruta.trim().split(/\s+/)[0] ?? "";
      if (regra === "" || regra === "home.arpa" || regra.startsWith("//") || !/^[a-z0-9.-]+$/.test(regra) || !regra.includes(".")) continue;
      expect(isPublicSuffix(regra), regra).toBe(true);
      expect(apexOf(regra), regra).toBeNull();
      expect(apexOf(`example.${regra}`), regra).toBe(`example.${regra}`);
      verificadas++;
    }
    expect(verificadas).toBeGreaterThan(4000);
  });

  it("curingas e exceções da cópia valem no motor", () => {
    const dat = readFileSync(COPIA, "utf8");
    const icann = dat.slice(dat.indexOf("===BEGIN ICANN"), dat.indexOf("===END ICANN"));
    let curingas = 0;
    let excecoes = 0;
    for (const bruta of icann.split("\n")) {
      const regra = bruta.trim().split(/\s+/)[0] ?? "";
      if (/^\*\.[a-z0-9.-]+$/.test(regra)) {
        const base = regra.slice(2);
        expect(isPublicSuffix(`x.${base}`), regra).toBe(true);
        curingas++;
      } else if (/^![a-z0-9.-]+$/.test(regra)) {
        const nome = regra.slice(1);
        expect(isPublicSuffix(nome), regra).toBe(false);
        expect(apexOf(`www.${nome}`), regra).toBe(nome);
        excecoes++;
      }
    }
    expect(curingas).toBeGreaterThan(5);
    expect(excecoes).toBeGreaterThan(5);
  });

  it("tem as entradas da CentralNic e os países; a seção privada de hospedagens fica de fora", () => {
    expect(PSL_RULES.com).toContain("br");
    expect(PSL_RULES.com).not.toMatch(/(^| )blogspot( |$)/);
    expect(PSL_RULES.net).toContain("uk");
    expect(PSL_COUNTRY_TLDS).toEqual(expect.arrayContaining(["br", "de", "uk", "io", "co"]));
    expect(PSL_RULES.br).toContain("*.nom");
    expect(PSL_RULES.br).not.toContain("santos");
  });
});
